import {
  assignXumEnvironmentValue,
  resolveXumEnvironmentValue,
  type XumEnvironment,
} from "../../src/common/compat/xumEnv";

export function getXumE2EEnv(
  suffix: string,
  env: XumEnvironment = process.env
): string | undefined {
  return resolveXumEnvironmentValue(suffix, env);
}

export function setXumE2EEnv(env: XumEnvironment, suffix: string, value: string): void {
  assignXumEnvironmentValue(env, suffix, value);
}
