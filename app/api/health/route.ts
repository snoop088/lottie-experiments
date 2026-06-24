import { NextResponse } from "next/server";

// Liveness probe — confirms the Next.js API runtime is up on Amplify.
export async function GET() {
  return NextResponse.json({ ok: true, service: "lottie-app", ts: Date.now() });
}
