export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.ELYTRA_MODERATION === "true") {
    const { startModerationWorker } = await import("./server/moderation/worker");
    startModerationWorker();
  }
}
