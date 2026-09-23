import { Rest } from "./lib/rest";
import { Anteros } from "./lib/anteros";
import { Collection } from "./lib/collection";
import { Files } from "./lib/files";
import { Service } from "./lib/service";
import { Vars } from "./lib/vars";
import { Agent } from "./lib/agents";
import { cleanDeep } from "./utils";

export { Rest, Anteros, Collection, Files, Service, Vars, Agent, cleanDeep };
export type {
    ApiAction,
    FileResult,
    FindOptions,
    LookupOptions,
    PublicConfig,
    RestClientOptions,
    RestQueryOptions,
    RestRequestOptions,
    UploadOptions,
} from "./types/rest";
export type { VarEntry, VarsAllOptions, VarsScopeOptions, VarsSetOptions } from "./types/vars";
export type {
    AgentAttachment,
    AgentInfo,
    AgentInput,
    AgentMessage,
    AgentResult,
    AgentRunOptions,
    AgentStep,
    AgentStream,
    AgentStreamChunk,
    AgentThread,
    AgentToolCall,
    AgentToolResultEntry,
    AgentUsage,
} from "./types/agents";
