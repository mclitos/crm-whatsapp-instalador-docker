import { execFileSync } from "node:child_process";

const defaultRunCommand = (command, args) => execFileSync(command, args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const parseServices = (output) => {
  const value = output.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      return value.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
};

export const resolveTunnelPort = ({
  environment = process.env,
  runCommand = defaultRunCommand,
} = {}) => {
  if (typeof environment.PORT === "string" && environment.PORT.length > 0) {
    return environment.PORT;
  }

  try {
    const services = parseServices(runCommand(
      "docker",
      ["compose", "ps", "--format", "json", "crm"],
    ));
    const dockerCrm = services.find((service) => (
      service?.Service === "crm"
      && service.State === "running"
      && (!service.Health || service.Health === "healthy")
      && Array.isArray(service.Publishers)
      && service.Publishers.some((publisher) => (
        Number(publisher?.TargetPort) === 3000 && Number(publisher?.PublishedPort) === 3300
      ))
    ));
    if (dockerCrm) return "3300";
  } catch {
    // Docker is optional; the classic Node runtime still uses port 3000.
  }
  return "3000";
};
