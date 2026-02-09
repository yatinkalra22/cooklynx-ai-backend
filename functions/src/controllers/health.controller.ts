import {Controller, Get, Route, Tags} from "tsoa";
import {HealthResponse} from "../types/api.types";

@Route("")
@Tags("Health")
export class HealthController extends Controller {
  /**
   * Health check endpoint
   * @summary Check API health status
   */
  @Get("health")
  public async getHealth(): Promise<HealthResponse> {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Test endpoint
   * @summary Simple hello endpoint for testing
   */
  @Get("v1/hello")
  public async hello(): Promise<{message: string}> {
    return {message: "Hello from CookLynx AI!"};
  }
}
