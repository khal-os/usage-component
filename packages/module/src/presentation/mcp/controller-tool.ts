import { Controller, HttpRequest, HttpResponse } from '../interfaces/index.js';
import { ToolError, fromHttpResponse } from './tool-error.js';
import { ToolOutcome, toolFailed, toolOk } from './tool-definition.js';

/**
 * Every read tool is the SAME call the HTTP route makes (decision 175):
 * one controller, one validation, one view schema — parity by construction
 * instead of a second implementation that drifts. This adapter is the whole
 * bridge; a tool is then a name, a schema and an argument mapping.
 */
export type ControllerCall =
  | { readonly ok: true; readonly response: HttpResponse }
  | { readonly ok: false; readonly error: ToolError };

export const callController = async (
  controller: Controller,
  request: HttpRequest,
): Promise<ControllerCall> => {
  const response = await controller.handle(request);

  return response.statusCode >= 200 && response.statusCode < 300
    ? { ok: true, response }
    : { ok: false, error: fromHttpResponse(response) };
};

/** A JSON read: the controller's body IS the tool's structured result. */
export const jsonFromController = async (
  controller: Controller,
  request: HttpRequest,
): Promise<ToolOutcome> => {
  const call = await callController(controller, request);

  return call.ok
    ? toolOk(call.response.body as Record<string, unknown>)
    : toolFailed(call.error);
};
