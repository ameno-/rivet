import { afterEach, describe, expect, test } from "vitest";
import {
	PiMateCredentialError,
	buildCredentialSource,
	describeMissing,
} from "../src/credentials.ts";

const ENV_KEYS = ["PI_MATE_TEST_PROVIDER_ONE", "PI_MATE_TEST_PROVIDER_TWO"];

const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		delete savedEnv[key];
	}
});

function saveAndClear(key: string) {
	savedEnv[key] = process.env[key];
	delete process.env[key];
}

describe("buildCredentialSource", () => {
	test("lists only providers whose env var is currently set", async () => {
		saveAndClear("PI_MATE_TEST_PROVIDER_ONE");
		saveAndClear("PI_MATE_TEST_PROVIDER_TWO");
		process.env.PI_MATE_TEST_PROVIDER_ONE = "alpha";
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
			"provider-two": "PI_MATE_TEST_PROVIDER_TWO",
		});
		const entries = await source.list();
		expect(entries).toEqual([
			{ providerId: "provider-one", type: "api_key" },
		]);
	});

	test("reads the current env var value when set", async () => {
		saveAndClear("PI_MATE_TEST_PROVIDER_ONE");
		process.env.PI_MATE_TEST_PROVIDER_ONE = "alpha-key";
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
		});
		const credential = await source.read("provider-one");
		expect(credential).toEqual({ type: "api_key", key: "alpha-key" });
	});

	test("reads the value freshly after the env var is rotated", async () => {
		saveAndClear("PI_MATE_TEST_PROVIDER_ONE");
		process.env.PI_MATE_TEST_PROVIDER_ONE = "first-key";
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
		});
		expect(await source.read("provider-one")).toEqual({
			type: "api_key",
			key: "first-key",
		});
		process.env.PI_MATE_TEST_PROVIDER_ONE = "second-key";
		expect(await source.read("provider-one")).toEqual({
			type: "api_key",
			key: "second-key",
		});
	});

	test("treats whitespace-only env var values as missing", async () => {
		saveAndClear("PI_MATE_TEST_PROVIDER_ONE");
		process.env.PI_MATE_TEST_PROVIDER_ONE = "   ";
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
		});
		const entries = await source.list();
		expect(entries).toEqual([]);
	});

	test("rejects reads of an unset provider with a typed error", async () => {
		saveAndClear("PI_MATE_TEST_PROVIDER_ONE");
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
		});
		await expect(source.read("provider-one")).rejects.toBeInstanceOf(
			PiMateCredentialError,
		);
	});

	test("returns undefined for providers the service does not configure", async () => {
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
		});
		expect(await source.read("unconfigured-provider")).toBeUndefined();
	});

	test("refresh returns the current key without re-echoing the secret", async () => {
		saveAndClear("PI_MATE_TEST_PROVIDER_ONE");
		process.env.PI_MATE_TEST_PROVIDER_ONE = "rotated-key";
		const source = buildCredentialSource({
			"provider-one": "PI_MATE_TEST_PROVIDER_ONE",
		});
		const refreshed = await source.refresh("provider-one");
		expect(refreshed).toEqual({ type: "api_key", key: "rotated-key" });
	});
});

describe("describeMissing", () => {
	test("returns a safe, non-secret description", () => {
		expect(describeMissing("PI_MATE_TEST_PROVIDER_ONE")).toEqual({
			providerId: "PI_MATE_TEST_PROVIDER_ONE",
			reason: "env_var_unset",
		});
	});
});
