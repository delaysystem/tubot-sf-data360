import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				serviceBindings: {
					TUBOT_SF_AUTH: (request: Request) => {
						return new Response(JSON.stringify({ ok: true, access_token: "test-token" }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					},
					TUBOT_SF_PARSER: (request: Request) => {
						return new Response(JSON.stringify({ ok: true }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
					},
				},
			},
		}),
	],
});
