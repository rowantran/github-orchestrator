import { matchingLink, receipt, type CompletionRequest, type Link, type Receipt, type Registry } from "./bridge";

export const COMPLETION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CompletionPort {
  readReceipt(): Promise<Receipt | undefined>;
  saveReceipt(value: Receipt): Promise<void>;
  registry(): Promise<Registry>;
  resolve(link: Link): Promise<{ path: string; status: unknown }>;
  apiAvailable(): boolean;
  setDone(path: string): Promise<void>;
  notice(message: string): void;
}

/** Caller holds the shared store lock. Receipts give at-most-once attempts, not remote confirmation. */
export async function processCompletion(
  request: CompletionRequest, port: CompletionPort, now = Date.now(),
): Promise<void> {
  const existing = await port.readReceipt();
  if (existing) {
    if (existing.requestId !== request.id || existing.linkId !== request.linkId
        || existing.issueFingerprint !== request.issueFingerprint || existing.schemaVersion !== 1
        || !["processing", "local-accepted", "already-done", "api-unavailable", "stale", "failed", "rolled-back", "interrupted"].includes(existing.status)) {
      throw new Error("Receipt identity or status mismatch; request will not be replayed.");
    }
    if (existing.status === "processing") {
      await port.saveReceipt(receipt(request, "interrupted", "Previous attempt stopped without a final receipt. Inspect task status, then explicitly request again.", existing.notePath));
    } else if (existing.status === "local-accepted" || existing.status === "already-done") {
      const link = matchingLink(request, await port.registry());
      if (link) {
        let current;
        try { current = await port.resolve(link); }
        catch { return; } // Missing or uncached notes do not prove a rollback.
        if (current.status !== "Done") {
          await port.saveReceipt(receipt(request, "rolled-back", "Task is no longer Done: remote rejection or a later local status change. Inspect Notion/TaskNotes before explicitly retrying.", current.path));
          port.notice(`GitHub completion did not remain Done: ${current.path}. Check TaskNotes and Notion.`);
        }
      }
    }
    return;
  }
  if (now - Date.parse(request.requestedAt) > COMPLETION_MAX_AGE_MS) {
    await port.saveReceipt(receipt(request, "stale", "Request is older than 24 hours. Recheck every linked GitHub issue and explicitly request completion again."));
    port.notice("GitHub completion request expired after 24 hours. Recheck GitHub before requesting completion again.");
    return;
  }
  const link = matchingLink(request, await port.registry());
  if (!link) {
    await port.saveReceipt(receipt(request, "stale", "Association or exact issue set changed. Recheck GitHub and request again."));
    return;
  }
  try {
    const current = await port.resolve(link);
    if (!port.apiAvailable()) {
      await port.saveReceipt(receipt(request, "api-unavailable", "Enable/update TaskNotes with runtime tasks.write and tasks.events capabilities, then explicitly request again. HTTP API is not required.", current.path));
      port.notice("GitHub completion needs TaskNotes runtime API. Enable/update TaskNotes, then request completion again.");
      return;
    }
    if (current.status === "Done") {
      await port.saveReceipt(receipt(request, "already-done", "Local task was already Done. This is not confirmation from Notion.", current.path));
      return;
    }
    // Persist before calling TaskNotes; an interrupted attempt must not silently repeat.
    await port.saveReceipt(receipt(request, "processing", "Local TaskNotes request started; no remote confirmation.", current.path));
    await port.setDone(current.path);
    const after = await port.resolve(link);
    await port.saveReceipt(receipt(request, after.status === "Done" ? "local-accepted" : "rolled-back",
      after.status === "Done" ? "TaskNotes accepted local completion. Notion confirmation is not observable by this bridge."
        : "TaskNotes did not retain Done; completion failed or was rolled back. Check TaskNotes/Notion before retrying.", after.path));
    port.notice(after.status === "Done" ? `TaskNotes accepted completion: ${after.path}. Notion is not confirmed.`
      : `Task completion was rolled back: ${after.path}. Check TaskNotes and Notion.`);
  } catch (error) {
    await port.saveReceipt(receipt(request, "failed", `Completion failed; inspect task state before explicitly retrying. ${String(error)}`, link.notePath));
    port.notice(`GitHub completion failed: ${link.notePath}. ${String(error)}`);
  }
}
