import { execFileSync } from "node:child_process";

const defaultRunCommand = (command, args, options) => {
  execFileSync(command, args, { ...options, shell: false, stdio: "inherit" });
};

export const runDockerLifecycle = ({
  directory,
  forceSetup = false,
  runCommand = defaultRunCommand,
} = {}) => {
  const options = { cwd: directory };
  runCommand("docker", ["compose", "stop", "installer", "crm"], options);

  const installerArgs = ["compose", "run", "--build", "--service-ports", "--rm"];
  if (forceSetup) installerArgs.push("-e", "CRM_FORCE_SETUP=1");
  installerArgs.push("installer");
  runCommand("docker", installerArgs, options);

  runCommand("docker", ["compose", "up", "--build", "-d", "crm"], options);
};
