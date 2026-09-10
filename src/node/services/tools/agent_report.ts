import { jsonSchema, tool, type ToolExecutionOptions } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import {
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
  type JsonSchemaValidationError,
} from "@/common/utils/jsonSchemaSubset";
import {
  createOptionalNullSchemaContract,
  type OptionalNullSchemaContract,
} from "@/common/utils/tools/optionalNullSchema";
import { sanitizeWorkflowAgentReportSchemaForOpenAI } from "@/common/utils/tools/schemaSanitizer";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  AgentReportInlineToolArgsSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { requireTaskService, requireWorkspaceId } from "./toolUtils";

interface AgentReportSuccessResult {
  success: true;
  message: string;
}

interface AgentProgressReport {
  reportMarkdown: string;
  title?: string;
  structuredOutput?: unknown;
}

interface AgentReportFailureResult {
  success: false;
  message: string;
  errors: JsonSchemaValidationError[];
}

type AgentReportResult = AgentReportSuccessResult | AgentReportFailureResult;

function validationFailure(
  message: string,
  errors: JsonSchemaValidationError[]
): AgentReportFailureResult {
  return { success: false, message, errors };
}

function zodValidationFailure(
  message: string,
  error: { issues: Array<{ path: unknown[]; message: string }> }
) {
  return validationFailure(
    message,
    error.issues.map((issue) => ({
      path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
      message: issue.message,
    }))
  );
}

/**
 * A workflow output schema is the host contract (Ajv validation, persistence).
 * The model sees the optional-null contract's widened schema; its `restore`
 * returns the payload to the host contract before validation.
 */
interface WorkflowOutputContract {
  outputSchema: Record<string, unknown>;
  contract: OptionalNullSchemaContract;
}

function getWorkflowOutputContract(config: ToolConfiguration): WorkflowOutputContract | undefined {
  const outputSchema = config.workflowAgentOutputSchema;
  if (outputSchema == null) {
    return undefined;
  }
  const schemaValidation = validateJsonSchemaSubsetSchema(outputSchema, {
    requireObjectSchema: true,
  });
  if (schemaValidation.success) {
    const hostSchema = outputSchema as Record<string, unknown>;
    return { outputSchema: hostSchema, contract: createOptionalNullSchemaContract(hostSchema) };
  }
  if (config.allowLegacyInvalidWorkflowAgentOutputSchema === true) {
    return undefined;
  }
  throw new Error("Invalid workflow agent output schema for agent_report.");
}

function validateStructuredOutput(
  outputSchema: Record<string, unknown>,
  structuredOutput: unknown
) {
  const validation = validateJsonSchemaSubset(outputSchema, structuredOutput);
  return validation.success
    ? null
    : validationFailure("Structured output failed schema validation.", validation.errors);
}

function buildInlineInputSchema(workflow: WorkflowOutputContract) {
  // Expose an OpenAI-compatible schema to providers while keeping the richer
  // Ajv schema for host-side validation in executeInlineReport.
  const providerFacingSchema = sanitizeWorkflowAgentReportSchemaForOpenAI(
    workflow.contract.modelSchema
  ) as JSONSchema7;
  return jsonSchema(providerFacingSchema, {
    validate: (value) => {
      const restoredValue = workflow.contract.restore(value);
      const validation = validateStructuredOutput(workflow.outputSchema, restoredValue);
      if (validation) {
        return { success: false, error: new Error(validation.message) };
      }
      return { success: true, value: restoredValue };
    },
  });
}

function parseProgressReport(
  workflow: WorkflowOutputContract | undefined,
  rawArgs: unknown
): { report: AgentProgressReport } | { failure: AgentReportFailureResult } {
  if (workflow != null) {
    // The AI SDK already restored SDK-parsed input; restoring again is idempotent
    // and covers direct execute callers.
    const restoredArgs = workflow.contract.restore(rawArgs);
    const structuredValidation = validateStructuredOutput(workflow.outputSchema, restoredArgs);
    if (structuredValidation) {
      return { failure: structuredValidation };
    }
    return {
      report: {
        reportMarkdown: "Structured workflow update submitted.",
        structuredOutput: restoredArgs,
      },
    };
  }

  const parsed = AgentReportInlineToolArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      failure: zodValidationFailure("Report arguments failed validation.", parsed.error),
    };
  }

  return {
    report: {
      reportMarkdown: parsed.data.reportMarkdown,
      title: parsed.data.title ?? undefined,
    },
  };
}

export const createAgentReportTool: ToolFactory = (config: ToolConfiguration) => {
  const workflow = getWorkflowOutputContract(config);
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: workflow ? buildInlineInputSchema(workflow) : AgentReportInlineToolArgsSchema,
    execute: async (
      args: unknown,
      options: ToolExecutionOptions<unknown>
    ): Promise<AgentReportResult> => {
      const workspaceId = requireWorkspaceId(config, "agent_report");
      const taskService = requireTaskService(config, "agent_report");
      const parsed = parseProgressReport(workflow, args);
      if ("failure" in parsed) {
        return parsed.failure;
      }

      await taskService.reportAgentProgress(workspaceId, options.toolCallId, parsed.report);
      return {
        success: true,
        message: "Update sent to the parent workspace.",
      };
    },
  });
};
