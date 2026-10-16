type EmailCodeLink = { attemptId: string; code: string; activated: boolean };
declare global {
  interface Window {
    __emailCodeLink?: EmailCodeLink | null;
  }
}
// The first HTML script scrubbed the fragment before any resources or telemetry booted.
// Keep one in-memory value across React strict-mode remounts; never persist it.
export const emailCodeLink = window.__emailCodeLink ?? null;
delete window.__emailCodeLink;
