import localDeployment from "../../../deployments/intracampus.json" with { type: "json" };
import cloudDeployment from "../../../deployments/intracampus-cloud.json" with { type: "json" };
import { CAMPUS_CHAIN_ID, CLOUD_CAMPUS_CHAIN_ID } from "./chain.ts";

export const selectedDeploymentManifest = CAMPUS_CHAIN_ID === CLOUD_CAMPUS_CHAIN_ID ? cloudDeployment : localDeployment;
