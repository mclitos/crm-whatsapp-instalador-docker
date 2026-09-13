export const DEFAULT_CRM_REPO_URL = "https://github.com/mclitos/wacrm.git";

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

export const resolveCrmRepoUrl = ({ environment = process.env, credentials = {} } = {}) => {
  if (nonEmpty(environment.CRM_REPO_URL)) return environment.CRM_REPO_URL.trim();
  if (nonEmpty(credentials.CRM_REPO_URL)) return credentials.CRM_REPO_URL.trim();
  return DEFAULT_CRM_REPO_URL;
};
