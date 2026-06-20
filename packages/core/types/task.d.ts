import type { io } from "../server/io";
import type { useRest } from "../database/rest";

export type Task = {
    name: string;
    pattern: string;
    enabled: boolean;
    exec: (ctx: {
        io: InstanceType<typeof io>;
        rest: InstanceType<typeof useRest>
    }) => void
}