import { playwrightMcp } from "./playwright";
import { mysqlMcp } from "./mysql";

/** Built-in MCP modules shipped and loaded with the application. */
export const internalMcpCatalog = [playwrightMcp, mysqlMcp];
