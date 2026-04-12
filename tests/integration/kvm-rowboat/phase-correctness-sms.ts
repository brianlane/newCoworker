import { isKvm8ComposeFile, type KvmStack } from "../kvm-stack-helpers";
import { SMS_SCENARIOS } from "../integration-scenarios";
import type { CorrectnessSmsCapture } from "./correctness-responses-io";
import {
  expectRowboatChatResponseShape,
  postRowboatMultiTurnThread
} from "./rowboat-chat";

/**
 * Rowboat `/chat` **contract**: HTTP 200 per turn, JSON shape, non-empty assistant each turn.
 *
 * **Multi-turn E2E:** `userMessage` + optional `followUpUserMessages` are one Rowboat thread via
 * `conversationId` (each `/chat` sends only the new user turn). Benchmark adds regex / minLen on the **last** reply only.
 */
export async function runCorrectnessSmsPhase(stack: KvmStack, model: string): Promise<CorrectnessSmsCapture[]> {
  const smsLogCtx = {
    composeFile: stack.composeFile,
    ollamaModel: model,
    ollamaHostPort: stack.ports.ollama,
    recoverOllama: isKvm8ComposeFile(stack.composeFile)
  };

  console.log(
    `[integration correctness] ${stack.label} Rowboat SMS multi-turn shape checks (${SMS_SCENARIOS.length} scenarios) ollamaModel=${model}`
  );

  const captures: CorrectnessSmsCapture[] = [];
  for (let i = 0; i < SMS_SCENARIOS.length; i++) {
    const sc = SMS_SCENARIOS[i];
    const userSequence = [sc.userMessage, ...(sc.followUpUserMessages ?? [])];
    console.log(
      `[integration correctness] ${stack.label} SMS ${i + 1}/${SMS_SCENARIOS.length} (${sc.id}, ${userSequence.length} user turn(s)) model=${model}`
    );
    const thread = await postRowboatMultiTurnThread(stack.ports.rowboat, userSequence, smsLogCtx);
    for (let t = 0; t < thread.turns.length; t++) {
      expectRowboatChatResponseShape(
        thread.turns[t].turnJson,
        `${stack.label} ${sc.id} turn ${t + 1}/${thread.turns.length}`
      );
    }
    captures.push({
      id: sc.id,
      difficulty: sc.difficulty,
      difficultyRank: sc.difficultyRank,
      turns: thread.turns.map((turn, ti) => ({
        turnIndex: ti + 1,
        userMessage: turn.userMessage,
        assistantText: turn.assistantText,
        roundTripMs: turn.roundTripMs
      })),
      totalRoundTripMs: thread.totalRoundTripMs
    });
  }
  return captures;
}
