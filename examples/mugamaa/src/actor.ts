import { type ActorContext, actor } from "rivetkit";
import { Loop, workflow } from "rivetkit/workflow";
import { createCaseState } from "./engine.ts";
import {
	decidePhaseOutcome,
	initializeCase,
	recordCaseExhausted,
	runAuditPhase,
	runPlanningPhase,
	runWorksPhase,
} from "./phases.ts";
import { RecordsOffice } from "./records.ts";
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

const NO_RETRY_MODEL_STEP = { maxRetries: 0, timeout: 0 } as const;

/**
 * Phase-durable Mugamaa actor.
 *
 * Every model phase is a distinct zero-retry workflow step. A completed step
 * replays from workflow history after restart; an ambiguous in-flight model
 * action blocks instead of being issued again.
 */
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
			await ctx.step("initialize", async (step) => {
				initializeCase(
					step.state,
					new RecordsOffice(step.state, Date.now),
				);
			});

			await ctx.loop("iterate-case", async (loopCtx) => {
				await loopCtx.step("advance-iteration", async (step) => {
					step.state.iteration += 1;
				});

				await loopCtx.step({
					name: "planning",
					...NO_RETRY_MODEL_STEP,
					run: async (step) => {
						await runPlanningPhase(
							step.state,
							new RecordsOffice(step.state, Date.now),
							runner,
							policy,
						);
					},
				});

				await loopCtx.step({
					name: "works",
					...NO_RETRY_MODEL_STEP,
					run: async (step) => {
						await runWorksPhase(
							step.state,
							new RecordsOffice(step.state, Date.now),
							runner,
							policy,
						);
					},
				});

				await loopCtx.step({
					name: "audit",
					...NO_RETRY_MODEL_STEP,
					run: async (step) => {
						await runAuditPhase(
							step.state,
							new RecordsOffice(step.state, Date.now),
							runner,
							policy,
						);
					},
				});

				const decision = await loopCtx.step("decision", async (step) =>
					decidePhaseOutcome(
						step.state,
						new RecordsOffice(step.state, Date.now),
					),
				);

				if (
					decision.outcome.kind === "complete" ||
					decision.outcome.kind === "blocked"
				) {
					return Loop.break(undefined);
				}

				const exhausted = await loopCtx.step(
					"check-exhaustion",
					async (step) =>
						step.state.iteration >=
						step.state.charter.maxIterations,
				);
				if (exhausted) {
					await loopCtx.step("record-exhaustion", async (step) => {
						recordCaseExhausted(
							step.state,
							new RecordsOffice(step.state, Date.now),
						);
					});
					return Loop.break(undefined);
				}

				return Loop.continue(undefined);
			});
		}),
		actions: {
			getSnapshot: (c) => c.state,
		},
	});
}
