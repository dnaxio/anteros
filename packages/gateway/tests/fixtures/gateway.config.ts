import { defineGateway } from "../../index";

export default defineGateway({
    port: 0,
    microservices: [{ name: "pharmacie", upstream: "http://127.0.0.1:4000" }],
});
