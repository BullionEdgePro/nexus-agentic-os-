import { teamFileUrl, type TeamChatFile } from "@/lib/api";

/**
 * Download a team chat file under its own name (2 Nov 2026). Fetched with the
 * session cookie — the API is on another origin — then handed to the browser.
 */
export async function downloadFile(threadId: string, file: TeamChatFile): Promise<void> {
  const response = await fetch(teamFileUrl(threadId, file.id), { credentials: "include" });
  if (!response.ok) throw new Error(`API ${response.status} on the file`);
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
