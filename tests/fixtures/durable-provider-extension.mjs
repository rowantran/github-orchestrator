// Test-only Pi extension: registers a provider the way user extensions (for example a company proxy) do.
export default function (pi) {
  pi.registerProvider("extension-fixture", {
    baseUrl: process.env.GHO_TEST_PROVIDER_URL, api: "openai-completions", apiKey: "test-only-dummy-key",
    models: [{ id: "worker-model", name: "Worker", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
  });
}
