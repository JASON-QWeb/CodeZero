import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { Pool } from "pg";
import type { AppConfig } from "@agent/config";

type RunnableConfigLike = {
  configurable?: Record<string, unknown>;
};

type SerializedValue = {
  type: string;
  data: string;
};

type StoredCheckpoint = {
  threadId: string;
  checkpointNamespace: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpoint: SerializedValue;
  metadata: SerializedValue;
  createdAt: string;
};

type StoredWrite = {
  threadId: string;
  checkpointNamespace: string;
  checkpointId: string;
  taskId: string;
  writeIndex: number;
  channel: string;
  value: SerializedValue;
  createdAt: string;
};

type CheckpointFile = {
  checkpoints: StoredCheckpoint[];
  writes: StoredWrite[];
};

const emptyCheckpointFile = (): CheckpointFile => ({
  checkpoints: [],
  writes: [],
});

const TASKS = "__pregel_tasks";

export function createDurableCheckpointer(
  config: AppConfig,
): BaseCheckpointSaver {
  if (config.storage.driver === "postgres" && config.storage.databaseUrl) {
    return new PostgresLangGraphCheckpointSaver(config.storage.databaseUrl);
  }

  return new FileLangGraphCheckpointSaver(
    config.workflowGraph.checkpointFilePath,
  );
}

abstract class BaseSerializingCheckpointSaver extends BaseCheckpointSaver {
  protected async toTuple(
    checkpoint: StoredCheckpoint,
    writes: StoredWrite[],
    config?: RunnableConfigLike,
  ): Promise<CheckpointTuple> {
    const deserializedCheckpoint = await this.deserialize<Checkpoint>(
      checkpoint.checkpoint,
    );

    if (deserializedCheckpoint.v < 4 && checkpoint.parentCheckpointId) {
      await this.migratePendingSends(
        deserializedCheckpoint,
        checkpoint.threadId,
        checkpoint.checkpointNamespace,
        checkpoint.parentCheckpointId,
        writes,
      );
    }

    const tuple: CheckpointTuple = {
      config: (config ?? {
        configurable: {
          thread_id: checkpoint.threadId,
          checkpoint_ns: checkpoint.checkpointNamespace,
          checkpoint_id: checkpoint.checkpointId,
        },
      }) as CheckpointTuple["config"],
      checkpoint: deserializedCheckpoint,
      metadata: await this.deserialize<CheckpointMetadata>(checkpoint.metadata),
      pendingWrites: await this.deserializeWrites(
        checkpoint.threadId,
        checkpoint.checkpointNamespace,
        checkpoint.checkpointId,
        writes,
      ),
    };

    if (checkpoint.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: checkpoint.threadId,
          checkpoint_ns: checkpoint.checkpointNamespace,
          checkpoint_id: checkpoint.parentCheckpointId,
        },
      };
    }

    return tuple;
  }

  protected async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNamespace: string,
    parentCheckpointId: string,
    writes: StoredWrite[],
  ): Promise<void> {
    const pendingSends = await Promise.all(
      writes
        .filter(
          (write) =>
            sameCheckpoint(
              write,
              threadId,
              checkpointNamespace,
              parentCheckpointId,
            ) && write.channel === TASKS,
        )
        .map((write) => this.deserialize(write.value)),
    );
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = pendingSends;
    checkpoint.channel_versions ??= {};
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }

  protected async deserializeWrites(
    threadId: string,
    checkpointNamespace: string,
    checkpointId: string,
    writes: StoredWrite[],
  ): Promise<CheckpointPendingWrite[]> {
    return Promise.all(
      writes
        .filter((write) =>
          sameCheckpoint(write, threadId, checkpointNamespace, checkpointId),
        )
        .sort((left, right) => left.writeIndex - right.writeIndex)
        .map(async (write) => [
          write.taskId,
          write.channel,
          await this.deserialize(write.value),
        ]),
    );
  }

  protected async serialize(value: unknown): Promise<SerializedValue> {
    const [type, data] = await this.serde.dumpsTyped(value);
    return { type, data: Buffer.from(data).toString("base64") };
  }

  protected async deserialize<T>(value: SerializedValue): Promise<T> {
    return this.serde.loadsTyped(
      value.type,
      Buffer.from(value.data, "base64"),
    ) as Promise<T>;
  }
}

export class FileLangGraphCheckpointSaver extends BaseSerializingCheckpointSaver {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    super();
  }

  async getTuple(
    config: RunnableConfigLike,
  ): Promise<CheckpointTuple | undefined> {
    const store = await this.read();
    const checkpoint = selectCheckpoint(store.checkpoints, config);
    return checkpoint
      ? this.toTuple(checkpoint, store.writes, config)
      : undefined;
  }

  async *list(
    config: RunnableConfigLike,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const store = await this.read();
    const candidates = listCheckpoints(store.checkpoints, config, options);
    let remaining = options.limit;

    for (const checkpoint of candidates) {
      const tuple = await this.toTuple(checkpoint, store.writes);

      if (options.filter && !metadataMatches(tuple.metadata, options.filter)) {
        continue;
      }

      if (remaining !== undefined) {
        if (remaining <= 0) {
          break;
        }

        remaining -= 1;
      }

      yield tuple;
    }
  }

  async put(
    config: RunnableConfigLike,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfigLike> {
    const threadId = requiredString(
      config.configurable?.thread_id,
      "thread_id",
    );
    const checkpointNamespace =
      stringValue(config.configurable?.checkpoint_ns) ?? "";
    const parentCheckpointId = stringValue(config.configurable?.checkpoint_id);
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const stored: StoredCheckpoint = {
      threadId,
      checkpointNamespace,
      checkpointId: checkpoint.id,
      parentCheckpointId,
      checkpoint: await this.serialize(preparedCheckpoint),
      metadata: await this.serialize(metadata),
      createdAt: new Date().toISOString(),
    };

    await this.mutate((store) => {
      store.checkpoints = [
        ...store.checkpoints.filter(
          (entry) =>
            !sameCheckpoint(
              entry,
              threadId,
              checkpointNamespace,
              checkpoint.id,
            ),
        ),
        stored,
      ];
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfigLike,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = requiredString(
      config.configurable?.thread_id,
      "thread_id",
    );
    const checkpointNamespace =
      stringValue(config.configurable?.checkpoint_ns) ?? "";
    const checkpointId = requiredString(
      config.configurable?.checkpoint_id,
      "checkpoint_id",
    );
    const storedWrites = await Promise.all(
      writes.map(
        async ([channel, value], index): Promise<StoredWrite> => ({
          threadId,
          checkpointNamespace,
          checkpointId,
          taskId,
          writeIndex: WRITES_IDX_MAP[String(channel)] ?? index,
          channel: String(channel),
          value: await this.serialize(value),
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    await this.mutate((store) => {
      for (const write of storedWrites) {
        const existingIndex = store.writes.findIndex((entry) =>
          sameWrite(entry, write),
        );

        if (existingIndex >= 0 && write.writeIndex >= 0) {
          continue;
        }

        if (existingIndex >= 0) {
          store.writes[existingIndex] = write;
        } else {
          store.writes.push(write);
        }
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.mutate((store) => {
      store.checkpoints = store.checkpoints.filter(
        (checkpoint) => checkpoint.threadId !== threadId,
      );
      store.writes = store.writes.filter(
        (write) => write.threadId !== threadId,
      );
    });
  }

  private async read(): Promise<CheckpointFile> {
    const content = await readFile(this.filePath, "utf8").catch(() => "");

    if (!content) {
      return emptyCheckpointFile();
    }

    try {
      const parsed = JSON.parse(content) as CheckpointFile;
      return {
        checkpoints: Array.isArray(parsed.checkpoints)
          ? parsed.checkpoints
          : [],
        writes: Array.isArray(parsed.writes) ? parsed.writes : [],
      };
    } catch {
      await rename(
        this.filePath,
        `${this.filePath}.corrupt-${Date.now()}`,
      ).catch(() => undefined);
      return emptyCheckpointFile();
    }
  }

  private async mutate(
    operation: (store: CheckpointFile) => void,
  ): Promise<void> {
    const next = this.queue.then(async () => {
      const store = await this.read();
      operation(store);
      await this.write(store);
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async write(store: CheckpointFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`);
    await rename(tempPath, this.filePath);
  }
}

export class PostgresLangGraphCheckpointSaver extends BaseSerializingCheckpointSaver {
  private readonly pool: Pool;
  private migration?: Promise<void>;

  constructor(databaseUrl: string) {
    super();
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  override async getTuple(
    config: RunnableConfigLike,
  ): Promise<CheckpointTuple | undefined> {
    const store = await this.readPostgres(config);
    const checkpoint = selectCheckpoint(store.checkpoints, config);
    return checkpoint
      ? this.toTuple(checkpoint, store.writes, config)
      : undefined;
  }

  override async *list(
    config: RunnableConfigLike,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const store = await this.readPostgres(config, options);
    const candidates = listCheckpoints(store.checkpoints, config, options);
    let remaining = options.limit;

    for (const checkpoint of candidates) {
      const tuple = await this.toTuple(checkpoint, store.writes);

      if (options.filter && !metadataMatches(tuple.metadata, options.filter)) {
        continue;
      }

      if (remaining !== undefined) {
        if (remaining <= 0) {
          break;
        }

        remaining -= 1;
      }

      yield tuple;
    }
  }

  override async put(
    config: RunnableConfigLike,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfigLike> {
    await this.migrate();
    const threadId = requiredString(
      config.configurable?.thread_id,
      "thread_id",
    );
    const checkpointNamespace =
      stringValue(config.configurable?.checkpoint_ns) ?? "";
    const parentCheckpointId = stringValue(config.configurable?.checkpoint_id);
    const serializedCheckpoint = await this.serialize(
      copyCheckpoint(checkpoint),
    );
    const serializedMetadata = await this.serialize(metadata);

    await this.pool.query(
      `insert into langgraph_checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint_type, checkpoint_data, metadata_type, metadata_data, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (thread_id, checkpoint_ns, checkpoint_id) do update set
        parent_checkpoint_id = excluded.parent_checkpoint_id,
        checkpoint_type = excluded.checkpoint_type,
        checkpoint_data = excluded.checkpoint_data,
        metadata_type = excluded.metadata_type,
        metadata_data = excluded.metadata_data,
        created_at = excluded.created_at`,
      [
        threadId,
        checkpointNamespace,
        checkpoint.id,
        parentCheckpointId ?? null,
        serializedCheckpoint.type,
        serializedCheckpoint.data,
        serializedMetadata.type,
        serializedMetadata.data,
      ],
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  override async putWrites(
    config: RunnableConfigLike,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await this.migrate();
    const threadId = requiredString(
      config.configurable?.thread_id,
      "thread_id",
    );
    const checkpointNamespace =
      stringValue(config.configurable?.checkpoint_ns) ?? "";
    const checkpointId = requiredString(
      config.configurable?.checkpoint_id,
      "checkpoint_id",
    );

    for (let index = 0; index < writes.length; index += 1) {
      const [channel, value] = writes[index] ?? ["", undefined];
      const writeIndex = WRITES_IDX_MAP[String(channel)] ?? index;
      const serialized = await this.serialize(value);
      await this.pool.query(
        `insert into langgraph_checkpoint_writes
          (thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx, channel, value_type, value_data, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx) do update set
          channel = excluded.channel,
          value_type = excluded.value_type,
          value_data = excluded.value_data,
          created_at = excluded.created_at
         where excluded.write_idx < 0`,
        [
          threadId,
          checkpointNamespace,
          checkpointId,
          taskId,
          writeIndex,
          String(channel),
          serialized.type,
          serialized.data,
        ],
      );
    }
  }

  override async deleteThread(threadId: string): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `delete from langgraph_checkpoint_writes where thread_id = $1`,
      [threadId],
    );
    await this.pool.query(
      `delete from langgraph_checkpoints where thread_id = $1`,
      [threadId],
    );
  }

  private async migrate(): Promise<void> {
    this.migration ??= this.pool
      .query(
        `
      create table if not exists langgraph_checkpoints (
        thread_id text not null,
        checkpoint_ns text not null,
        checkpoint_id text not null,
        parent_checkpoint_id text,
        checkpoint_type text not null,
        checkpoint_data text not null,
        metadata_type text not null,
        metadata_data text not null,
        created_at timestamptz not null default now(),
        primary key (thread_id, checkpoint_ns, checkpoint_id)
      );

      create table if not exists langgraph_checkpoint_writes (
        thread_id text not null,
        checkpoint_ns text not null,
        checkpoint_id text not null,
        task_id text not null,
        write_idx integer not null,
        channel text not null,
        value_type text not null,
        value_data text not null,
        created_at timestamptz not null default now(),
        primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx)
      );
    `,
      )
      .then(() => undefined);
    await this.migration;
  }

  private async readPostgres(
    config: RunnableConfigLike = {},
    options: CheckpointListOptions = {},
  ): Promise<CheckpointFile> {
    await this.migrate();
    const threadId = stringValue(config.configurable?.thread_id);
    const checkpointNamespace = stringValue(config.configurable?.checkpoint_ns);
    const checkpointId =
      getCheckpointId(config as CheckpointTuple["config"]) ??
      stringValue(config.configurable?.checkpoint_id);
    const beforeId = stringValue(options.before?.configurable?.checkpoint_id);
    const checkpointQuery = buildCheckpointSelectQuery({
      threadId,
      checkpointNamespace,
      checkpointId,
      beforeId,
    });
    const writesQuery = buildWritesSelectQuery({
      threadId,
      checkpointNamespace,
    });
    const [checkpoints, writes] = await Promise.all([
      this.pool.query<{
        thread_id: string;
        checkpoint_ns: string;
        checkpoint_id: string;
        parent_checkpoint_id: string | null;
        checkpoint_type: string;
        checkpoint_data: string;
        metadata_type: string;
        metadata_data: string;
        created_at: Date;
      }>(checkpointQuery.sql, checkpointQuery.values),
      this.pool.query<{
        thread_id: string;
        checkpoint_ns: string;
        checkpoint_id: string;
        task_id: string;
        write_idx: number;
        channel: string;
        value_type: string;
        value_data: string;
        created_at: Date;
      }>(writesQuery.sql, writesQuery.values),
    ]);

    return {
      checkpoints: checkpoints.rows.map((row) => ({
        threadId: row.thread_id,
        checkpointNamespace: row.checkpoint_ns,
        checkpointId: row.checkpoint_id,
        parentCheckpointId: row.parent_checkpoint_id ?? undefined,
        checkpoint: { type: row.checkpoint_type, data: row.checkpoint_data },
        metadata: { type: row.metadata_type, data: row.metadata_data },
        createdAt: row.created_at.toISOString(),
      })),
      writes: writes.rows.map((row) => ({
        threadId: row.thread_id,
        checkpointNamespace: row.checkpoint_ns,
        checkpointId: row.checkpoint_id,
        taskId: row.task_id,
        writeIndex: row.write_idx,
        channel: row.channel,
        value: { type: row.value_type, data: row.value_data },
        createdAt: row.created_at.toISOString(),
      })),
    };
  }
}

function buildCheckpointSelectQuery(input: {
  threadId?: string;
  checkpointNamespace?: string;
  checkpointId?: string;
  beforeId?: string;
}): { sql: string; values: string[] } {
  const values: string[] = [];
  const filters: string[] = [];
  const addFilter = (
    column: string,
    value: string | undefined,
    operator = "=",
  ) => {
    if (value === undefined) {
      return;
    }

    values.push(value);
    filters.push(`${column} ${operator} $${values.length}`);
  };

  addFilter("thread_id", input.threadId);
  addFilter("checkpoint_ns", input.checkpointNamespace);
  addFilter("checkpoint_id", input.checkpointId);
  addFilter("checkpoint_id", input.beforeId, "<");

  return {
    sql: [
      `select thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        checkpoint_type, checkpoint_data, metadata_type, metadata_data, created_at
       from langgraph_checkpoints`,
      filters.length > 0 ? `where ${filters.join(" and ")}` : "",
      "order by checkpoint_id desc",
    ]
      .filter(Boolean)
      .join("\n"),
    values,
  };
}

function buildWritesSelectQuery(input: {
  threadId?: string;
  checkpointNamespace?: string;
}): { sql: string; values: string[] } {
  const values: string[] = [];
  const filters: string[] = [];
  const addFilter = (column: string, value: string | undefined) => {
    if (value === undefined) {
      return;
    }

    values.push(value);
    filters.push(`${column} = $${values.length}`);
  };

  addFilter("thread_id", input.threadId);
  addFilter("checkpoint_ns", input.checkpointNamespace);

  return {
    sql: [
      `select thread_id, checkpoint_ns, checkpoint_id, task_id, write_idx,
        channel, value_type, value_data, created_at
       from langgraph_checkpoint_writes`,
      filters.length > 0 ? `where ${filters.join(" and ")}` : "",
      "order by write_idx asc",
    ]
      .filter(Boolean)
      .join("\n"),
    values,
  };
}

function selectCheckpoint(
  checkpoints: StoredCheckpoint[],
  config: RunnableConfigLike,
): StoredCheckpoint | undefined {
  const threadId = stringValue(config.configurable?.thread_id);
  const checkpointNamespace =
    stringValue(config.configurable?.checkpoint_ns) ?? "";
  const checkpointId = getCheckpointId(config as CheckpointTuple["config"]);
  const candidates = checkpoints.filter(
    (checkpoint) =>
      (!threadId || checkpoint.threadId === threadId) &&
      checkpoint.checkpointNamespace === checkpointNamespace &&
      (!checkpointId || checkpoint.checkpointId === checkpointId),
  );

  return candidates.sort(compareCheckpointDesc)[0];
}

function listCheckpoints(
  checkpoints: StoredCheckpoint[],
  config: RunnableConfigLike,
  options: CheckpointListOptions,
): StoredCheckpoint[] {
  const threadId = stringValue(config.configurable?.thread_id);
  const checkpointNamespace = stringValue(config.configurable?.checkpoint_ns);
  const checkpointId = stringValue(config.configurable?.checkpoint_id);
  const beforeId = stringValue(options.before?.configurable?.checkpoint_id);
  return checkpoints
    .filter(
      (checkpoint) =>
        (!threadId || checkpoint.threadId === threadId) &&
        (checkpointNamespace === undefined ||
          checkpoint.checkpointNamespace === checkpointNamespace) &&
        (!checkpointId || checkpoint.checkpointId === checkpointId) &&
        (!beforeId || checkpoint.checkpointId < beforeId),
    )
    .sort(compareCheckpointDesc);
}

function metadataMatches(
  metadata: CheckpointMetadata | undefined,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(
    ([key, value]) =>
      (metadata as Record<string, unknown> | undefined)?.[key] === value,
  );
}

function compareCheckpointDesc(
  left: StoredCheckpoint,
  right: StoredCheckpoint,
): number {
  return (
    right.checkpointId.localeCompare(left.checkpointId) ||
    right.createdAt.localeCompare(left.createdAt)
  );
}

function sameCheckpoint(
  checkpoint: Pick<
    StoredCheckpoint,
    "threadId" | "checkpointNamespace" | "checkpointId"
  >,
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string,
): boolean {
  return (
    checkpoint.threadId === threadId &&
    checkpoint.checkpointNamespace === checkpointNamespace &&
    checkpoint.checkpointId === checkpointId
  );
}

function sameWrite(left: StoredWrite, right: StoredWrite): boolean {
  return (
    left.threadId === right.threadId &&
    left.checkpointNamespace === right.checkpointNamespace &&
    left.checkpointId === right.checkpointId &&
    left.taskId === right.taskId &&
    left.writeIndex === right.writeIndex
  );
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);

  if (!result) {
    throw new Error(`LangGraph checkpoint config is missing ${name}`);
  }

  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
