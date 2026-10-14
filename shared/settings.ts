import type { Settings } from "./types";

export const isSnowflake = (value: unknown): value is string =>
  typeof value === "string" && /^\d{17,20}$/.test(value);

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings.");
  const input = value as Record<string, unknown>;
  const boolean = (key: string): boolean => {
    if (typeof input[key] !== "boolean") throw new Error(`Invalid ${key}.`);
    return input[key];
  };
  const ids = (key: string, max: number): string[] => {
    const list = input[key];
    if (!Array.isArray(list) || list.length > max || !list.every(isSnowflake)) {
      throw new Error(`Choose up to ${max} valid ${key === "honeypotChannelIds" ? "honeypot channels" : "excluded roles"}.`);
    }
    return [...new Set(list)];
  };
  const integer = (key: string, min: number, max: number): number => {
    const number = input[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${key === "spamThreshold" ? "Channel threshold" : "Time window"} must be between ${min} and ${max}.`);
    }
    return number;
  };
  if (input.reviewChannelId !== null && !isSnowflake(input.reviewChannelId)) throw new Error("Choose a valid review channel.");
  const result: Settings = {
    honeypotEnabled: boolean("honeypotEnabled"),
    honeypotChannelIds: ids("honeypotChannelIds", 10),
    honeypotWarn: boolean("honeypotWarn"),
    honeypotDelete: boolean("honeypotDelete"),
    spamEnabled: boolean("spamEnabled"),
    spamThreshold: integer("spamThreshold", 2, 20),
    spamWindowSeconds: integer("spamWindowSeconds", 5, 300),
    spamWarn: boolean("spamWarn"),
    spamDelete: boolean("spamDelete"),
    excludedRoleIds: ids("excludedRoleIds", 50),
    reviewChannelId: input.reviewChannelId as string | null,
  };
  if (result.honeypotEnabled && result.honeypotChannelIds.length === 0) throw new Error("Choose a honeypot channel before enabling it.");
  if (result.reviewChannelId && result.honeypotChannelIds.includes(result.reviewChannelId)) throw new Error("The review channel must be separate from your honeypot.");
  return result;
}
