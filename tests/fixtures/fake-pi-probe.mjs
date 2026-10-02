// Extension commands and handled input hooks only; this fixture never invokes a model.
import orchestration from "../../extensions/orchestration.mjs";

export default function probe(pi) {
  pi.on("input", async (event, ctx) => {
    if (event.text === "fixture-input-hook") {
      const answer = await ctx.ui.confirm("fixture-input-hook", "fixture");
      ctx.ui.notify(JSON.stringify({ inputDialogAnswer: answer }), "info");
    }
    return { action: "handled" };
  });
  pi.registerCommand("gho-probe", {
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify({
        probe: true,
        systemPrompt: ctx.getSystemPrompt(),
        tools: pi.getActiveTools(),
        allTools: pi.getAllTools().map((tool) => tool.name),
        trusted: ctx.isProjectTrusted(),
        settings: { steeringMode: pi.getSettings().steeringMode },
        cwd: ctx.cwd,
      }), "info");
    },
  });
  pi.registerCommand("gho-probe-report", {
    handler: async (args, ctx) => {
      let tool;
      await orchestration({ registerTool: (value) => { tool = value; }, on: () => {} });
      try {
        const result = await tool.execute("fixture", JSON.parse(args), undefined);
        ctx.ui.notify(JSON.stringify({ reportResult: result }), "info");
      } catch (error) {
        ctx.ui.notify(JSON.stringify({ reportError: error.message }), "info");
      }
    },
  });
  pi.registerCommand("gho-probe-dialog", {
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.confirm("fixture", "fixture");
      ctx.ui.notify(JSON.stringify({ dialogAnswer: answer }), "info");
    },
  });
}
