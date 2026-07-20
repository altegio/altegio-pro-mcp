/**
 * Compatibility facade.
 *
 * The tool logic now lives in per-category factory definitions under
 * `./definitions`. `ToolHandlers` is retained as a thin adapter that binds each
 * `DefinedTool` to a client, so existing unit/integration suites that
 * instantiate it keep working. New code should use `./definitions` + the
 * registry directly; `withErrorHandling`/`ToolResult` live in `./tool-result`.
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import type { DefinedTool } from './factory.js';
import * as defs from './definitions/index.js';

export { withErrorHandling } from './tool-result.js';
export type { ToolResult } from './tool-result.js';

export class ToolHandlers {
  constructor(private client: AltegioClient) {}

  private run(tool: DefinedTool, args: unknown) {
    return tool.createHandler(this.client)(args);
  }

  login = (args: unknown) => this.run(defs.loginTool, args);
  logout = () => this.run(defs.logoutTool, {});
  listCompanies = (args?: unknown) => this.run(defs.listCompaniesTool, args);
  getBookings = (args: unknown) => this.run(defs.getBookingsTool, args);
  getStaff = (args: unknown) => this.run(defs.getStaffTool, args);
  getServices = (args: unknown) => this.run(defs.getServicesTool, args);
  getServiceCategories = (args: unknown) =>
    this.run(defs.getServiceCategoriesTool, args);
  getSchedule = (args: unknown) => this.run(defs.getScheduleTool, args);
  createSchedule = (args: unknown) => this.run(defs.createScheduleTool, args);
  updateSchedule = (args: unknown) => this.run(defs.updateScheduleTool, args);
  deleteSchedule = (args: unknown) => this.run(defs.deleteScheduleTool, args);
  getPositions = (args: unknown) => this.run(defs.getPositionsTool, args);
  createPosition = (args: unknown) => this.run(defs.createPositionTool, args);
  updatePosition = (args: unknown) => this.run(defs.updatePositionTool, args);
  deletePosition = (args: unknown) => this.run(defs.deletePositionTool, args);
  createStaff = (args: unknown) => this.run(defs.createStaffTool, args);
  updateStaff = (args: unknown) => this.run(defs.updateStaffTool, args);
  deleteStaff = (args: unknown) => this.run(defs.deleteStaffTool, args);
  createService = (args: unknown) => this.run(defs.createServiceTool, args);
  updateService = (args: unknown) => this.run(defs.updateServiceTool, args);
  createBooking = (args: unknown) => this.run(defs.createBookingTool, args);
  updateBooking = (args: unknown) => this.run(defs.updateBookingTool, args);
  deleteBooking = (args: unknown) => this.run(defs.deleteBookingTool, args);
}
