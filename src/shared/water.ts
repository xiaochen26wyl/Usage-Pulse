import { WATER_CUP_SIZES_ML, type WaterCupSizeMl } from "@shared/types";

export const DEFAULT_WATER_REMINDER_MINUTES = 50;
export const MIN_WATER_REMINDER_MINUTES = 5;
export const MAX_WATER_REMINDER_MINUTES = 180;
export const DEFAULT_WATER_CUP_SIZE_ML: WaterCupSizeMl = 500;

export const isWaterCupSizeMl = (value: unknown): value is WaterCupSizeMl =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  (WATER_CUP_SIZES_ML as readonly number[]).includes(value);

export const normalizeWaterCupSize = (value: unknown): WaterCupSizeMl => {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return isWaterCupSizeMl(numeric) ? numeric : DEFAULT_WATER_CUP_SIZE_ML;
};

export const clampWaterReminderMinutes = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WATER_REMINDER_MINUTES;
  }
  return Math.min(
    MAX_WATER_REMINDER_MINUTES,
    Math.max(MIN_WATER_REMINDER_MINUTES, Math.round(numeric))
  );
};
