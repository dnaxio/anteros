import type { Hono } from "hono";
import { cfg } from "./config";
import path from "path";
import { jwt } from "../utils/func";
import { useRest } from "../database/rest";
import { io } from "./io";
import { requestCtxStorage } from "../lib/asyncContextStorage";
import type { HonoVariables } from "./env";

function initializeRoutes(app: Hono<{ Variables: HonoVariables }>) {
    for (let route of cfg.routes ?? []) {
        if (route._prefix_) {
          let method = route.method.toLocaleLowerCase();
          let routePath = path.posix.join(route._prefix_, route.path);

            // Resolve the tenant in the request context so the access log,
            // nested useRest() calls and audit see the right tenant_id
            const resolveTenant = () => {
                requestCtxStorage.set('tenant_id', route._tenant_);
            };



            if (route.method == "GET") {
                app.get(routePath, async (c) => { //
                    resolveTenant();
                    return route.handler({
                        c,
                        rest: new useRest({
                            tenant_id: route._tenant_,
                        }),
                        jwt: jwt,
                        io: io,
                    });
                });
            }

            if (route.method == 'POST') {
                app.post(routePath, async (c) => {
                    resolveTenant();
                    return route.handler({
                        c,
                        rest: new useRest({
                            tenant_id: route._tenant_,
                        }),
                        jwt: jwt,
                        io: io,
                    });
                });
            }

            if (route.method == "PUT") {
                app.put(routePath, async (c) => { //
                    resolveTenant();
                    return route.handler({
                        c,
                        rest: new useRest({
                            tenant_id: route._tenant_,
                        }),
                        jwt: jwt,
                        io: io,
                    });
                });
            }
        }
    }

}


export {
    initializeRoutes
}
