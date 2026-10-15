import "server-only";
import { channel } from "node:diagnostics_channel";

// Subscribers can export telemetry without adding a monitoring SDK to every request.
const requests = channel("elytra.api.request");
export function observeRequest(event: { requestId: string; method: string; route: string; status: number; durationMs: number }): void {
  if (requests.hasSubscribers) {
    try { requests.publish(event); } catch (error) { console.error("Request telemetry subscriber failed", error); }
  }
  if (process.env.ELYTRA_LOG_REQUESTS === "true") console.log(JSON.stringify({ event: "api_request", ...event }));
}
