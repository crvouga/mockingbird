import type { MockCreateOptions, MockSurface } from "@crvouga/mockingbird-service"
import type { createRuntime as createAcm } from "@crvouga/mockingbird-service-acm"
import type { createRuntime as createAha } from "@crvouga/mockingbird-service-aha"
import type { createRuntime as createAirtable } from "@crvouga/mockingbird-service-airtable"
import type { createRuntime as createApigateway } from "@crvouga/mockingbird-service-apigateway"
import type { createRuntime as createAppStoreConnect } from "@crvouga/mockingbird-service-app-store-connect"
import type { createRuntime as createApple } from "@crvouga/mockingbird-service-apple"
import type { createRuntime as createAws } from "@crvouga/mockingbird-service-aws"
import type { createRuntime as createAwsIot } from "@crvouga/mockingbird-service-aws-iot"
import type { createRuntime as createAwsSecrets } from "@crvouga/mockingbird-service-aws-secrets"
import type { createRuntime as createAwsSpeech } from "@crvouga/mockingbird-service-aws-speech"
import type { createRuntime as createBedrock } from "@crvouga/mockingbird-service-bedrock"
import type { createRuntime as createBrevo } from "@crvouga/mockingbird-service-brevo"
import type { createRuntime as createCaretalk } from "@crvouga/mockingbird-service-caretalk"
import type { createRuntime as createCheckr } from "@crvouga/mockingbird-service-checkr"
import type { createRuntime as createClerk } from "@crvouga/mockingbird-service-clerk"
import type { createRuntime as createCloudcontrol } from "@crvouga/mockingbird-service-cloudcontrol"
import type { createRuntime as createCloudformation } from "@crvouga/mockingbird-service-cloudformation"
import type { createRuntime as createCloudwatch } from "@crvouga/mockingbird-service-cloudwatch"
import type { createRuntime as createCloudwatchLogs } from "@crvouga/mockingbird-service-cloudwatch-logs"
import type { createRuntime as createCognito } from "@crvouga/mockingbird-service-cognito"
import type { createRuntime as createConfig } from "@crvouga/mockingbird-service-config"
import type { createRuntime as createCustomerio } from "@crvouga/mockingbird-service-customerio"
import type { createRuntime as createDaily } from "@crvouga/mockingbird-service-daily"
import type { createRuntime as createDocker } from "@crvouga/mockingbird-service-docker"
import type { createRuntime as createDynamodb } from "@crvouga/mockingbird-service-dynamodb"
import type { createRuntime as createDynamodbStreams } from "@crvouga/mockingbird-service-dynamodb-streams"
import type { createRuntime as createEasypost } from "@crvouga/mockingbird-service-easypost"
import type { createRuntime as createEc2 } from "@crvouga/mockingbird-service-ec2"
import type { createRuntime as createECS } from "@crvouga/mockingbird-service-ecs"
import type { createRuntime as createEdamam } from "@crvouga/mockingbird-service-edamam"
import type { createRuntime as createElasticsearch } from "@crvouga/mockingbird-service-elasticsearch"
import type { createRuntime as createElevenlabs } from "@crvouga/mockingbird-service-elevenlabs"
import type { createRuntime as createEmqx } from "@crvouga/mockingbird-service-emqx"
import type { createRuntime as createEventBridge } from "@crvouga/mockingbird-service-eventbridge"
import type { createRuntime as createFcm } from "@crvouga/mockingbird-service-fcm"
import type { createRuntime as createFirehose } from "@crvouga/mockingbird-service-firehose"
import type { createRuntime as createFirstpromoter } from "@crvouga/mockingbird-service-firstpromoter"
import type { createRuntime as createFitbit } from "@crvouga/mockingbird-service-fitbit"
import type { createRuntime as createFlex } from "@crvouga/mockingbird-service-flex"
import type { createRuntime as createFormbricks } from "@crvouga/mockingbird-service-formbricks"
import type { createRuntime as createFullscript } from "@crvouga/mockingbird-service-fullscript"
import type { createRuntime as createGarminHealth } from "@crvouga/mockingbird-service-garmin-health"
import type { createRuntime as createGenebygene } from "@crvouga/mockingbird-service-genebygene"
import type { createRuntime as createGithub } from "@crvouga/mockingbird-service-github"
import type { createRuntime as createGoogle } from "@crvouga/mockingbird-service-google"
import type { createRuntime as createGoogleAds } from "@crvouga/mockingbird-service-google-ads"
import type { createRuntime as createGoogleCalendar } from "@crvouga/mockingbird-service-google-calendar"
import type { createRuntime as createGoogleMaps } from "@crvouga/mockingbird-service-google-maps"
import type { createRuntime as createHealthie } from "@crvouga/mockingbird-service-healthie"
import type { createRuntime as createHermes } from "@crvouga/mockingbird-service-hermes"
import type { createRuntime as createIam } from "@crvouga/mockingbird-service-iam"
import type { createRuntime as createInfisical } from "@crvouga/mockingbird-service-infisical"
import type { createRuntime as createIntercom } from "@crvouga/mockingbird-service-intercom"
import type { createRuntime as createJunction } from "@crvouga/mockingbird-service-junction"
import type { createRuntime as createKillBill } from "@crvouga/mockingbird-service-kill-bill"
import type { createRuntime as createKinesis } from "@crvouga/mockingbird-service-kinesis"
import type { createRuntime as createKlaviyo } from "@crvouga/mockingbird-service-klaviyo"
import type { createRuntime as createKms } from "@crvouga/mockingbird-service-kms"
import type { createRuntime as createLambda } from "@crvouga/mockingbird-service-lambda"
import type { createRuntime as createLinear } from "@crvouga/mockingbird-service-linear"
import type { createRuntime as createLivekit } from "@crvouga/mockingbird-service-livekit"
import type { createRuntime as createLlamacloud } from "@crvouga/mockingbird-service-llamacloud"
import type { createRuntime as createMailosaur } from "@crvouga/mockingbird-service-mailosaur"
import type { createRuntime as createMediaconvert } from "@crvouga/mockingbird-service-mediaconvert"
import type { createRuntime as createMedplum } from "@crvouga/mockingbird-service-medplum"
import type { createRuntime as createMeta } from "@crvouga/mockingbird-service-meta"
import type { createRuntime as createMicrosoft } from "@crvouga/mockingbird-service-microsoft"
import type { createRuntime as createMongoatlas } from "@crvouga/mockingbird-service-mongoatlas"
import type { createRuntime as createNotion } from "@crvouga/mockingbird-service-notion"
import type { createRuntime as createOauth } from "@crvouga/mockingbird-service-oauth"
import type { createRuntime as createOdx } from "@crvouga/mockingbird-service-odx"
import type { createRuntime as createOkta } from "@crvouga/mockingbird-service-okta"
import type { createRuntime as createOpenAI } from "@crvouga/mockingbird-service-openai"
import type { createRuntime as createOpensearch } from "@crvouga/mockingbird-service-opensearch"
import type { createRuntime as createOtel } from "@crvouga/mockingbird-service-otel"
import type { createRuntime as createOura } from "@crvouga/mockingbird-service-oura"
import type { createRuntime as createPaddle } from "@crvouga/mockingbird-service-paddle"
import type { createRuntime as createPayloadCms } from "@crvouga/mockingbird-service-payload-cms"
import type { createRuntime as createPersona } from "@crvouga/mockingbird-service-persona"
import type { createRuntime as createPharmetika } from "@crvouga/mockingbird-service-pharmetika"
import type { createRuntime as createPlane } from "@crvouga/mockingbird-service-plane"
import type { createRuntime as createPolar } from "@crvouga/mockingbird-service-polar"
import type { createRuntime as createPosthog } from "@crvouga/mockingbird-service-posthog"
import type { createRuntime as createPrism } from "@crvouga/mockingbird-service-prism"
import type { createRuntime as createRecaptcha } from "@crvouga/mockingbird-service-recaptcha"
import type { createRuntime as createRedshift } from "@crvouga/mockingbird-service-redshift"
import type { createRuntime as createResend } from "@crvouga/mockingbird-service-resend"
import type { createRuntime as createResourceGroups } from "@crvouga/mockingbird-service-resource-groups"
import type { createRuntime as createResourceGroupsTaggingApi } from "@crvouga/mockingbird-service-resource-groups-tagging-api"
import type { createRuntime as createRoute53 } from "@crvouga/mockingbird-service-route53"
import type { createRuntime as createRoute53resolver } from "@crvouga/mockingbird-service-route53resolver"
import type { createRuntime as createRxvortex } from "@crvouga/mockingbird-service-rxvortex"
import type { createRuntime as createS3 } from "@crvouga/mockingbird-service-s3"
import type { createRuntime as createS3Control } from "@crvouga/mockingbird-service-s3-control"
import type { createRuntime as createScheduler } from "@crvouga/mockingbird-service-scheduler"
import type { createRuntime as createSentry } from "@crvouga/mockingbird-service-sentry"
import type { createRuntime as createSes } from "@crvouga/mockingbird-service-ses"
import type { createRuntime as createSlack } from "@crvouga/mockingbird-service-slack"
import type { createRuntime as createSns } from "@crvouga/mockingbird-service-sns"
import type { createRuntime as createSqs } from "@crvouga/mockingbird-service-sqs"
import type { createRuntime as createSsm } from "@crvouga/mockingbird-service-ssm"
import type { createRuntime as createStepFunctions } from "@crvouga/mockingbird-service-step-functions"
import type { createRuntime as createStripe } from "@crvouga/mockingbird-service-stripe"
import type { createRuntime as createSts } from "@crvouga/mockingbird-service-sts"
import type { createRuntime as createSupport } from "@crvouga/mockingbird-service-support"
import type { createRuntime as createSuunto } from "@crvouga/mockingbird-service-suunto"
import type { createRuntime as createSwf } from "@crvouga/mockingbird-service-swf"
import type { createRuntime as createTavily } from "@crvouga/mockingbird-service-tavily"
import type { createRuntime as createTempo } from "@crvouga/mockingbird-service-tempo"
import type { createRuntime as createTextract } from "@crvouga/mockingbird-service-textract"
import type { createRuntime as createTurnstile } from "@crvouga/mockingbird-service-turnstile"
import type { createRuntime as createTwilio } from "@crvouga/mockingbird-service-twilio"
import type { createRuntime as createUnsplash } from "@crvouga/mockingbird-service-unsplash"
import type { createRuntime as createVanta } from "@crvouga/mockingbird-service-vanta"
import type { createRuntime as createVercel } from "@crvouga/mockingbird-service-vercel"
import type { createRuntime as createVercelBlob } from "@crvouga/mockingbird-service-vercel-blob"
import type { createRuntime as createVibe } from "@crvouga/mockingbird-service-vibe"
import type { createRuntime as createVpi } from "@crvouga/mockingbird-service-vpi"
import type { createRuntime as createWholescripts } from "@crvouga/mockingbird-service-wholescripts"
import type { createRuntime as createWhoop } from "@crvouga/mockingbird-service-whoop"
import type { createRuntime as createWorkos } from "@crvouga/mockingbird-service-workos"

/**
 * Every HTTP mock is created the same way and returns the same surface.
 * Extra methods stay. A missing member, or a createRuntime that cannot be called
 * with `{ sqlite?, clock?, seed?, adminKey? }`, is a type error on that line.
 */
type Factory = (options?: MockCreateOptions) => MockSurface
type Assert<T extends Factory> = T

export type SurfaceProof = [
  Assert<typeof createAws>,
  Assert<typeof createVercel>,
  Assert<typeof createGoogle>,
  Assert<typeof createApple>,
  Assert<typeof createMicrosoft>,
  Assert<typeof createOkta>,
  Assert<typeof createMongoatlas>,
  Assert<typeof createClerk>,
  Assert<typeof createLinear>,
  Assert<typeof createOura>,
  Assert<typeof createAha>,
  Assert<typeof createTavily>,
  Assert<typeof createAwsIot>,
  Assert<typeof createAwsSecrets>,
  Assert<typeof createAwsSpeech>,
  Assert<typeof createBedrock>,
  Assert<typeof createBrevo>,
  Assert<typeof createCaretalk>,
  Assert<typeof createCognito>,
  Assert<typeof createCustomerio>,
  Assert<typeof createDaily>,
  Assert<typeof createDynamodb>,
  Assert<typeof createEasypost>,
  Assert<typeof createEdamam>,
  Assert<typeof createElevenlabs>,
  Assert<typeof createEmqx>,
  Assert<typeof createFcm>,
  Assert<typeof createFirstpromoter>,
  Assert<typeof createFlex>,
  Assert<typeof createFormbricks>,
  Assert<typeof createFullscript>,
  Assert<typeof createGenebygene>,
  Assert<typeof createGoogleCalendar>,
  Assert<typeof createGoogleMaps>,
  Assert<typeof createHealthie>,
  Assert<typeof createInfisical>,
  Assert<typeof createIntercom>,
  Assert<typeof createJunction>,
  Assert<typeof createKillBill>,
  Assert<typeof createKlaviyo>,
  Assert<typeof createLivekit>,
  Assert<typeof createLlamacloud>,
  Assert<typeof createMailosaur>,
  Assert<typeof createMediaconvert>,
  Assert<typeof createMedplum>,
  Assert<typeof createNotion>,
  Assert<typeof createOauth>,
  Assert<typeof createGoogleAds>,
  Assert<typeof createOpenAI>,
  Assert<typeof createOdx>,
  Assert<typeof createOtel>,
  Assert<typeof createPaddle>,
  Assert<typeof createPayloadCms>,
  Assert<typeof createPersona>,
  Assert<typeof createPharmetika>,
  Assert<typeof createPlane>,
  Assert<typeof createPosthog>,
  Assert<typeof createPrism>,
  Assert<typeof createRecaptcha>,
  Assert<typeof createResend>,
  Assert<typeof createRxvortex>,
  Assert<typeof createSentry>,
  Assert<typeof createS3>,
  Assert<typeof createSlack>,
  Assert<typeof createSqs>,
  Assert<typeof createStepFunctions>,
  Assert<typeof createStripe>,
  Assert<typeof createTempo>,
  Assert<typeof createTextract>,
  Assert<typeof createTwilio>,
  Assert<typeof createTurnstile>,
  Assert<typeof createVercelBlob>,
  Assert<typeof createVpi>,
  Assert<typeof createVanta>,
  Assert<typeof createWholescripts>,
  Assert<typeof createAppStoreConnect>,
  Assert<typeof createAirtable>,
  Assert<typeof createCheckr>,
  Assert<typeof createWhoop>,
  Assert<typeof createWorkos>,
  Assert<typeof createECS>,
  Assert<typeof createEventBridge>,
  Assert<typeof createVibe>,
  Assert<typeof createUnsplash>,
  Assert<typeof createMeta>,
  Assert<typeof createKinesis>,
  Assert<typeof createSsm>,
  Assert<typeof createKms>,
  Assert<typeof createCloudwatch>,
  Assert<typeof createDocker>,
  Assert<typeof createS3Control>,
  Assert<typeof createCloudwatchLogs>,
  Assert<typeof createSns>,
  Assert<typeof createConfig>,
  Assert<typeof createOpensearch>,
  Assert<typeof createResourceGroupsTaggingApi>,
  Assert<typeof createScheduler>,
  Assert<typeof createRoute53resolver>,
  Assert<typeof createCloudcontrol>,
  Assert<typeof createRedshift>,
  Assert<typeof createIam>,
  Assert<typeof createGithub>,
  Assert<typeof createSupport>,
  Assert<typeof createLambda>,
  Assert<typeof createDynamodbStreams>,
  Assert<typeof createHermes>,
  Assert<typeof createFirehose>,
  Assert<typeof createSes>,
  Assert<typeof createCloudformation>,
  Assert<typeof createSwf>,
  Assert<typeof createElasticsearch>,
  Assert<typeof createApigateway>,
  Assert<typeof createSts>,
  Assert<typeof createAcm>,
  Assert<typeof createEc2>,
  Assert<typeof createResourceGroups>,
  Assert<typeof createRoute53>,
  Assert<typeof createFitbit>,
  Assert<typeof createGarminHealth>,
  Assert<typeof createPolar>,
  Assert<typeof createSuunto>,
]
