import { vi } from "vitest";
import type { WebServiceDependencies } from "../../packages/web/src/lib/server/dependencies";

export function createMockWebDeps(
  overrides: {
    db?: Partial<WebServiceDependencies["db"]>;
    mail?: Partial<WebServiceDependencies["mail"]>;
    llm?: Partial<WebServiceDependencies["llm"]>;
    workflows?: Partial<WebServiceDependencies["workflows"]>;
    avatars?: Partial<WebServiceDependencies["avatars"]>;
  } = {},
): WebServiceDependencies {
  const db = {
    agent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    task: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    agentMailThreadBinding: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    agentTurnLog: {
      findFirst: vi.fn(),
    },
    schedule: {
      findMany: vi.fn(),
    },
    conversation: {
      create: vi.fn(),
    },
  } as Record<string, unknown> & {
    $transaction?: <T>(fn: (tx: WebServiceDependencies["db"]) => Promise<T>) => Promise<T>;
  };
  db.$transaction = <T>(fn: (tx: WebServiceDependencies["db"]) => Promise<T>) =>
    fn(db as unknown as WebServiceDependencies["db"]);

  return {
    db: {
      ...db,
      ...overrides.db,
    } as WebServiceDependencies["db"],
    mail: {
      createInbox: vi.fn(),
      ...overrides.mail,
    },
    llm: {
      createText: vi.fn(),
      ...overrides.llm,
    },
    workflows: {
      startTaskWorkflow: vi.fn(),
      startScheduleWorkflow: vi.fn(),
      terminateWorkflow: vi.fn(),
      signalWorkflow: vi.fn(),
      describeWorkflow: vi.fn(),
      queryWorkflow: vi.fn(),
      ...overrides.workflows,
    },
    avatars: {
      generateAndUploadAvatar: vi.fn().mockResolvedValue("https://pub-example.test/pfps/agent-1.png"),
      ...overrides.avatars,
    },
  };
}
