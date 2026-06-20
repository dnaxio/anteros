import { useRest } from "../database/rest"


export type Script = {
    _isScript_?: boolean;
    enabled: boolean;
    exec: (ctx: {
        rest: InstanceType<typeof useRest>
    }) => void
}