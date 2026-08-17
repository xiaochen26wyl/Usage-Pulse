import type { ServiceType } from "@shared/types";
import { hasClaudeCodeOAuthToken, hasCursorAccessToken } from "@main/credential-provider";

export const getAuthStatus = async (): Promise<Record<ServiceType, boolean>> => {
  const [cursor, claude] = await Promise.all([hasCursorAccessToken(), hasClaudeCodeOAuthToken()]);
  return { cursor, claude };
};
