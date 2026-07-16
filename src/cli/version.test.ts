import { jest } from "@jest/globals";
import packageJson from "../../package.json";
import { runCli } from "./index";

describe("CLI version", () => {
  it("prints the package version without resolving configuration", async () => {
    const log = jest.spyOn(console, "log").mockImplementation();

    await runCli(["--version"]);

    expect(log).toHaveBeenCalledWith(packageJson.version);
  });
});
