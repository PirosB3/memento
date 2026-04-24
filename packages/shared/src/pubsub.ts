import { prisma } from "./db";

export type PendingMessage = {
  orderingKey: string;
  role: string;
  message: unknown;
};

export type TurnSnapshotState = {
  pending: PendingMessage[];
};

export function channelForTask(taskId: string): string {
  return `turn_${taskId.replace(/-/g, "_")}`;
}

export async function publishTurnSnapshot(
  taskId: string,
  pending: PendingMessage[],
): Promise<void> {
  const state: TurnSnapshotState = { pending };

  await prisma.turnSnapshot.upsert({
    where: { taskId },
    create: { taskId, state: state as never },
    update: { state: state as never },
  });

  const channel = channelForTask(taskId);
  await prisma.$executeRaw`SELECT pg_notify(${channel}, '')`;
}
