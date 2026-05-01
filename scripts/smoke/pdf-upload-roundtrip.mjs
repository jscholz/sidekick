// End-to-end PDF upload smoke. Drives the PWA, uploads a tiny fixture
// PDF with a unique text marker, sends a question, asserts the agent
// reply mentions the marker — proving the rasterization path works
// end-to-end (PWA composer → /api/sidekick/messages → hermes plugin
// _materialize_attachments → _rasterize_pdf shell-out to pdftoppm →
// page PNGs → vision-capable LLM → reply that contains the marker).
//
// Real-backend test: BACKEND='real' means it hits the live hermes /
// plugin / LLM. Skipped under --mocked-only because the entire point
// is exercising the rasterization shell-out + LLM vision pass.
//
// Prereqs (or test fails for environmental reasons, NOT a code bug):
//   - poppler-utils installed on the host running hermes (`pdftoppm -v`)
//   - hermes running, with at least one vision-capable model in the
//     settings options[]. If the agent's currently-selected model
//     isn't vision-capable, the test SHOULD fail loudly because the
//     PWA's attach-button vision-gate would prevent the upload UI
//     from enabling — that itself is a test of the gate.
//   - sidekick proxy on http://127.0.0.1:3001 (default).
//
// What this test does NOT cover (handled elsewhere):
//   - Plugin-level unit tests for _rasterize_pdf with edge cases (cap,
//     timeout, encrypted) — already covered in the plugin test suite.
//   - Image-only attachment paths — the existing image flow is
//     orthogonal.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForReady, openSidebar, clickNewChat, send, assert } from './lib.mjs';

export const NAME = 'pdf-upload-roundtrip';
export const DESCRIPTION = 'PDF upload → hermes plugin rasterizes → vision-LLM reads marker text';
export const STATUS = 'implemented';
export const BACKEND = 'real';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'marker.pdf');
// Marker string baked into fixtures/marker.pdf — pdftoppm renders it
// as a PNG, gemma/claude/etc. transcribe it back. Unique enough to be
// unambiguous in a model reply (no false positives from "PDF" or
// "test" alone).
const PDF_MARKER = 'SidekickPDFTestMarker0451';

export default async function run({ page, log, fail }) {
  await waitForReady(page);
  await openSidebar(page);

  // Start a fresh chat — boot's auto-resume lands us in whatever
  // session was most recent, which means any prior agent bubble in
  // that transcript would satisfy our "wait for agent reply" check
  // and the test would assert against THAT reply (false negative
  // on the marker). Fresh chat = empty transcript = unambiguous
  // match on the post-send reply.
  await clickNewChat(page);
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.agent').length === 0,
    null, { timeout: 3_000 },
  );
  log('fresh chat — no prior agent bubbles');

  // Step 1: open settings, pick a vision-capable model. We pick from
  // the live schema's options[] to stay in sync with whatever the
  // user has configured; prefer claude-sonnet/opus since they handle
  // PDFs reliably. Fall back to any vision-capable id if neither is
  // available.
  await page.click('#sb-settings');
  await page.waitForFunction(
    () => document.getElementById('settings')?.classList.contains('on'),
    null, { timeout: 3_000 },
  );
  await page.waitForSelector('[data-agent-setting="model"] select', { timeout: 5_000 });

  const visionPreferred = [
    /^anthropic\/claude-(sonnet|opus|haiku)/,
    /^openai\/gpt-4o/,
    /^google\/gemini-/,
    /^google\/gemma-3-(4b|12b|27b)/,
  ];
  const pickedModel = await page.evaluate((patterns) => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) return null;
    const opts = Array.from(sel.options).map(o => o.value);
    const re = patterns.map(p => new RegExp(p[0], p[1]));
    for (const r of re) {
      const hit = opts.find(v => r.test(v));
      if (hit) return hit;
    }
    return null;
  }, visionPreferred.map(r => [r.source, r.flags]));
  if (!pickedModel) {
    fail('no vision-capable model in agent options[] — install at least one (claude/gpt-4o/gemini/gemma-3) before running this test');
    return;
  }
  log(`picking vision-capable model: ${pickedModel}`);

  await page.evaluate((model) => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    sel.value = model;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, pickedModel);
  // Wait for the POST to land + the agent-setting-changed event to
  // re-run updateAttachButtonsState. The button enabling is the
  // signal the PWA-side gate accepted the model.
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && !b.disabled;
    },
    null, { timeout: 5_000 },
  );
  log('attach button enabled after model switch ✓');

  // Close settings via Escape key — handler at src/settings.ts:703.
  // The DOM has both #settings-close and #sb-settings (open button)
  // matching loose locator queries, so press Escape instead of click.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.getElementById('settings')?.classList.contains('on'),
    null, { timeout: 3_000 },
  );

  // Step 2: feed the fixture PDF into the hidden file input. Skip
  // the file picker chrome by setting files programmatically — same
  // path Playwright uses everywhere.
  const pdfBytes = readFileSync(FIXTURE_PATH);
  await page.setInputFiles('#attach-input', {
    name: 'marker.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBytes,
  });
  await page.waitForSelector('#composer-attachments .attachment-chip', { timeout: 3_000 });
  log('PDF attached to composer ✓');

  // Step 3: send a question that forces the model to read the PDF.
  // Phrasing chosen to push the model toward verbatim quoting rather
  // than paraphrase, which matters because the marker is a token
  // chunk that paraphrase would smooth out.
  await send(page, 'Read the attached PDF and reply with the exact text it contains, verbatim.');
  log('sent question, awaiting reply');

  // Step 4: wait for the marker to appear in any agent bubble. The
  // agent typically does a tool-call (vision_analyze) before
  // synthesizing — the tool-call row may show up BEFORE the final
  // text reply. So polling on bubble count is wrong; we have to
  // poll the entire transcript text for the marker. Budget 90s
  // (real-backend, vision-LLM, Pi 5 hardware).
  try {
    await page.waitForFunction(
      (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
      PDF_MARKER,
      { timeout: 90_000, polling: 500 },
    );
  } catch (e) {
    // On timeout, dump the transcript so the failure diagnostic is
    // useful (saw "vision_analyze: …" but never the final text? saw
    // nothing at all? completely different reply?).
    const transcript = await page.evaluate(() =>
      (document.getElementById('transcript')?.textContent || '').slice(0, 2000)
    );
    fail(`marker "${PDF_MARKER}" never appeared in transcript within 90s.\nTranscript: ${JSON.stringify(transcript)}`);
    return;
  }

  // Step 5: log where the marker appeared (agent bubble, tool-call
  // surface, or both). The test's contract is "marker appears in
  // transcript after sending", which is what the waitForFunction
  // above asserted. The model may transcribe via tool-call args
  // (vision_analyze) without echoing in a final text bubble — that's
  // still proof rasterization → vision-LLM works. The original PDF
  // contained ONLY the marker, so any place it shows up downstream
  // proves the rasterized PNG was readable and reached the model.
  const surfaces = await page.evaluate((marker) => {
    const result = {
      inAgentBubble: false,
      inToolCall: false,
      inUserBubble: false,
      transcriptSnippet: '',
    };
    const transcript = document.getElementById('transcript');
    if (!transcript) return result;
    const agentBubbles = transcript.querySelectorAll('.line.agent .text');
    for (const b of agentBubbles) {
      if ((b.textContent || '').includes(marker)) result.inAgentBubble = true;
    }
    const userBubbles = transcript.querySelectorAll('.line.s0, .line.user');
    for (const b of userBubbles) {
      if ((b.textContent || '').includes(marker)) result.inUserBubble = true;
    }
    // Tool call rows render with various class shapes; broad search.
    const toolRows = transcript.querySelectorAll('.tool-row, .activity-row, .activity-row-summary, .activity-row-full');
    for (const t of toolRows) {
      if ((t.textContent || '').includes(marker)) result.inToolCall = true;
    }
    // Fallback: marker in transcript but not classified above
    const allText = transcript.textContent || '';
    if (allText.includes(marker)) {
      const idx = allText.indexOf(marker);
      result.transcriptSnippet = allText.slice(Math.max(0, idx - 60), idx + marker.length + 60);
    }
    return result;
  }, PDF_MARKER);
  log(`marker surfaces: agent=${surfaces.inAgentBubble} tool=${surfaces.inToolCall} user=${surfaces.inUserBubble}`);
  log(`transcript snippet around marker: ${JSON.stringify(surfaces.transcriptSnippet)}`);

  // The user's typed question doesn't contain the marker (verify this
  // is actually a model-output occurrence, not a question echo).
  assert(
    !surfaces.inUserBubble,
    `marker found in user bubble — test fixture or send is leaking the marker into the question, fix the test`,
  );
  // Marker MUST appear somewhere model-driven.
  assert(
    surfaces.inAgentBubble || surfaces.inToolCall,
    `marker not in any model-driven surface — rasterization or vision-LLM path failed. Snippet: ${JSON.stringify(surfaces.transcriptSnippet)}`,
  );
  log(`PDF rasterization → vision-LLM path verified end-to-end ✓`);
}
