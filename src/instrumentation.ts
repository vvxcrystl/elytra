export async function register() {
  // Check the sign-in settings at startup, so a missing OIDC client fails here with its fix
  // instead of on the first page load.
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("./server/config")).accountsConfig();
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.ELYTRA_MODERATION === "true") {
    const { startModerationWorker } = await import("./server/moderation/worker");
    startModerationWorker();
  }
}
