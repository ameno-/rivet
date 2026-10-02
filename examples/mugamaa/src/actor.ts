import { type ActorContext, actor } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { createCaseState, Mugamaa } from "./engine.ts";
import type {
	CaseState,
	GoalCharter,
	ModelPolicy,
	OfficeRunner,
} from "./types.ts";

type MugamaaContext = ActorContext<
	CaseState,
	undefined,
	undefined,
	undefined,
	GoalCharter,
	undefined,
	Record<never, never>,
	Record<never, never>
>;

type MugamaaActions = {
	getSnapshot: (context: MugamaaContext) => CaseState;
};

export function createMugamaaActor(runner: OfficeRunner, policy: ModelPolicy) {
	return actor<
		CaseState,
		undefined,
		undefined,
		undefined,
		GoalCharter,
		undefined,
		Record<never, never>,
		Record<never, never>,
		MugamaaActions
	>({
		createState: (_c, charter: GoalCharter) => createCaseState(charter),
		run: workflow(async (ctx) => {
			const result = await ctx.step({
				name: "run-seed-case",
				maxRetries: 0,
				timeout: 0,
				run: async (step) =>
					await new Mugamaa({ policy, runner }).run(
						step.state.charter,
					),
			});
			await ctx.step("publish-seed-case", async (step) => {
				Object.assign(step.state, result);
			});
		}),
		actions: {
			getSnapshot: (c) => c.state,
		},
	});
}
