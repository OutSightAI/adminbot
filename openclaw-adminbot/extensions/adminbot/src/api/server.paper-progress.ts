// Narrow stage edits use the same ownership rules as the paper form, without a
// client-side GET/PUT that can overwrite a concurrent title or author edit.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotPaperProgressUpdate } from "../contracts/actions.js";
import type { AdminBotService } from "../kernel/service.js";
import { readJson, sendJson, sendServiceResult } from "./server.http.js";

export async function handlePaperProgressRoute(
  req: IncomingMessage,
  res: ServerResponse,
  service: AdminBotService,
  paperId: string,
  actor: { memberId: string; privileged: boolean },
): Promise<void> {
  const body = (await readJson(req)) as AdminBotPaperProgressUpdate;
  if (!body || typeof body.current_step !== "string") {
    sendJson(res, 400, { error: { message: "current_step is required" } });
    return;
  }
  if (!actor.privileged) {
    sendServiceResult(
      res,
      service.upsertOwnPaper(actor.memberId, {
        id: paperId,
        current_step: body.current_step,
      }),
    );
    return;
  }
  const snapshot = service.listPaperSlots(paperId);
  if (!snapshot.ok) {
    sendServiceResult(res, snapshot);
    return;
  }
  // Nothing awaits between the read and write, so this merge is atomic in the
  // service process. Only the requested stage can come from the client.
  sendServiceResult(
    res,
    service.upsertPaper(
      {
        ...snapshot.payload.paper,
        current_step: body.current_step,
      },
      { source: "admin", actor: actor.memberId },
    ),
  );
}
