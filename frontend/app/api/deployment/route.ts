import { deploymentResponse } from "@intracampus/network";

export function GET() {
  const result = deploymentResponse();
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
