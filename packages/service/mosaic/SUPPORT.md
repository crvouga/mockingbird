# Mosaic Diagnostics GPL API Services — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **156**
- supported by the emulator: **17**
- parity enabled: **17**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `UnsupportedGetContactinfoContactInfoId` | `GET /api/contactinfo/{contactInfoId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutContactinfo` | `PUT /api/contactinfo` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostContactinfo` | `POST /api/contactinfo` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetContacttype` | `GET /api/contacttype` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetCorrespondences` | `GET /api/Correspondences` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutCorrespondences` | `PUT /api/Correspondences` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostCorrespondences` | `POST /api/Correspondences` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedDeleteCorrespondencesId` | `DELETE /api/Correspondences/{id}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutCorrespondencesUnDeleteId` | `PUT /api/Correspondences/UnDelete/{id}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetCustomerCredit` | `GET /api/CustomerCredit` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutCustomerCredit` | `PUT /api/CustomerCredit` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostCustomerCredit` | `POST /api/CustomerCredit` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetCustomerCreditCard` | `GET /api/CustomerCreditCard` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostCustomerCreditCard` | `POST /api/CustomerCreditCard` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostCustomerCreditCardDelete` | `POST /api/CustomerCreditCard/delete` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerIssuesPageIndexRecordsPerPage` | `GET /api/DashboardPractitioner/Issues/{pageIndex}/{recordsPerPage}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerAwaitingPaymentPageIndexRecordsPerPage` | `GET /api/DashboardPractitioner/AwaitingPayment/{pageIndex}/{recordsPerPage}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerUnreturnedSamplesPageIndexRecordsPerPage` | `GET /api/DashboardPractitioner/UnreturnedSamples/{pageIndex}/{recordsPerPage}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerPendingShipmentPageIndexRecordsPerPage` | `GET /api/DashboardPractitioner/PendingShipment/{pageIndex}/{recordsPerPage}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerNewResultsPageIndexRecordsPerPage` | `GET /api/DashboardPractitioner/NewResults/{pageIndex}/{recordsPerPage}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerTotalCounts` | `GET /api/DashboardPractitioner/TotalCounts` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDashboardPractitionerTotalCounts2` | `GET /api/DashboardPractitioner/TotalCounts2` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetDiscountCode` | `GET /api/DiscountCode` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostDiscountCode` | `POST /api/DiscountCode` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostFortisCreatePayerToken` | `POST /api/fortis/CreatePayerToken` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostFortisCreatePayerTokenEncrypt` | `POST /api/fortis/CreatePayerTokenEncrypt` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostFortisCreditCardTokenPayment` | `POST /api/fortis/CreditCardTokenPayment` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostFortisBulkPayment` | `POST /api/fortis/BulkPayment` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetFunctionalAssessment` | `GET /api/FunctionalAssessment` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetFunctionalAssessmentTestType` | `GET /api/FunctionalAssessmentTestType` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListCountries` | `GET /api/Country` | ✅ supported | ✅ |  |
| `UnsupportedGetCountryGetStatesByCountryIdCountryId` | `GET /api/Country/GetStatesByCountryId/{countryId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListStates` | `GET /api/Country/States` | ✅ supported | ✅ |  |
| `UnsupportedGetCountryAddressValidate` | `GET /api/Country/address/validate` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostGuarantor` | `POST /api/Guarantor` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetHowHeardAboutUs` | `GET /api/HowHeardAboutUs` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitsExistsKitId` | `GET /api/kits/exists/{kitId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitsExistsKitIdPhysicianPhysicianId` | `GET /api/kits/exists/{kitId}/physician/{physicianId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostKits` | `POST /api/kits` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostKitsBulkKitsQuantity` | `POST /api/kits/BulkKits/{quantity}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitcategories` | `GET /api/kitcategories` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitorders` | `GET /api/kitorders` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutKitorders` | `PUT /api/kitorders` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostKitorders` | `POST /api/kitorders` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitordersKitOrderId` | `GET /api/kitorders/{kitOrderId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitordersContents` | `GET /api/kitorders/contents` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitordersKitOrderIdKits` | `GET /api/kitorders/{kitOrderId}/kits` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKitOvernightFees` | `GET /api/KitOvernightFees` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetKittypes` | `GET /api/kittypes` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListLanguages` | `GET /api/Language` | ✅ supported | ✅ |  |
| `UnsupportedGetLanguageGetCollectionInstructionsLanguages` | `GET /api/Language/GetCollectionInstructionsLanguages` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetNotifications` | `GET /api/Notifications` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutNotifications` | `PUT /api/Notifications` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostNotifications` | `POST /api/Notifications` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostNotificationsBulk` | `POST /api/Notifications/Bulk` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetNotificationsNotificationIdAttachment` | `GET /api/Notifications/{notificationId}/attachment` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetNotificationStatuses` | `GET /api/NotificationStatuses` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `GetPatient` | `GET /api/patient/{patientAccountId}` | ✅ supported | ✅ |  |
| `ListPatients` | `GET /api/patient` | ✅ supported | ✅ |  |
| `UpdatePatient` | `PUT /api/patient` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreatePatient` | `POST /api/patient/create` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UnsupportedPostPatientCreateAccount` | `POST /api/patient/createAccount` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPatientVerifyAccount` | `GET /api/patient/VerifyAccount` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPatientGetDNASnipHistory` | `GET /api/patient/GetDNASnipHistory` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostLabVantagePatient` | `POST /api/LabVantage/patient` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostLabVantagePatientEditPatient` | `POST /api/LabVantage/patient/EditPatient` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutPatientInsurances` | `PUT /api/PatientInsurances` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPatientInsurances` | `POST /api/PatientInsurances` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPatientInsurancesLookup` | `POST /api/PatientInsurances/Lookup` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPatientrelation` | `GET /api/patientrelation` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListResults` | `GET /api/PatientResults/{salesOrderId}` | ✅ supported | ✅ |  |
| `DownloadResult` | `GET /api/PatientResults/GetPDF` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetReportJson` | `GET /api/PatientResults/ReportJson/{testTypeId}` | ✅ supported | ✅ |  |
| `UnsupportedGetLabVantagePatientSalesOrderSalesorderSalesOrderIdPatientIds` | `GET /api/LabVantage/PatientSalesOrder/salesorder/{salesOrderId}/patientIds` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantagePatientSalesOrderSalesorderSalesOrderIdPatientSamples` | `GET /api/LabVantage/PatientSalesOrder/salesorder/{salesOrderId}/patientSamples` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPaymentmethod` | `GET /api/paymentmethod` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPaymentOnline` | `POST /api/PaymentOnline` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPaySource` | `GET /api/PaySource` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPhysicianSignatures` | `POST /api/PhysicianSignatures` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListTestTypes` | `GET /api/PortalTestType` | ✅ supported | ✅ |  |
| `UnsupportedGetPortalTestTypeFiltered` | `GET /api/PortalTestType/filtered` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPortalTestTypePricesFiltered` | `GET /api/PortalTestType/prices/filtered` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPortalTestTypeTopOrders` | `GET /api/PortalTestType/top-orders` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitioner` | `GET /api/practitioner` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutPractitioner` | `PUT /api/practitioner` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPractitioner` | `POST /api/practitioner` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPractitionerCreate` | `POST /api/practitioner/create` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerIsNPIValidNpiToValidate` | `GET /api/practitioner/IsNPIValid/{npiToValidate}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerIsLoginValid` | `GET /api/practitioner/IsLoginValid` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerPhysicianId` | `GET /api/practitioner/{physicianId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerFilter` | `GET /api/practitioner/Filter` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutPractitionerUpdatePassword` | `PUT /api/practitioner/UpdatePassword` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutPractitionerUpdateRecommendationOptOut` | `PUT /api/practitioner/UpdateRecommendationOptOut` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerTestTypePrice` | `GET /api/practitioner/TestTypePrice` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerUserGroupUserGroupId` | `GET /api/practitioner/UserGroup/{userGroupId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutLabVantagePractitioner` | `PUT /api/LabVantage/Practitioner` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostLabVantagePractitioner` | `POST /api/LabVantage/Practitioner` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerCredentialPractitionerCredentialId` | `GET /api/PractitionerCredential/{practitionerCredentialId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerCredential` | `GET /api/PractitionerCredential` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPractitionerQuestionnaireOptionsPractitionerQuestionnaireOptions` | `GET /api/PractitionerQuestionnaireOptions/PractitionerQuestionnaireOptions` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostPractitionerTestTypeDiscounts` | `POST /api/PractitionerTestTypeDiscounts` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetPrepaidUnredeemed` | `GET /api/prepaid/Unredeemed` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageProblemSampleSampleId` | `GET /api/LabVantage/Problem/sample/{sampleId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostSalesordersPatientOrderBulkCreate` | `POST /api/salesorders/PatientOrder/BulkCreate` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `CreateOrder` | `POST /api/salesorders/PatientOrder/Create` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UnsupportedPutSalesorders` | `PUT /api/salesorders` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `GetOrder` | `GET /api/salesorders/{salesOrderId}` | ✅ supported | ✅ |  |
| `UnsupportedGetSalesordersPractitionerPractitionerId` | `GET /api/salesorders/practitioner/{practitionerId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostSalesordersReview` | `POST /api/salesorders/Review` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostSalesordersEditReview` | `POST /api/salesorders/EditReview` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostSalesordersEdit` | `POST /api/salesorders/Edit` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetSalesordersInvoiceSalesOrderId` | `GET /api/salesorders/Invoice/{salesOrderId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutSalesordersUpdatepaymentPaymentMethodId` | `PUT /api/salesorders/updatepayment/{paymentMethodId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostSalesordersUnpaid` | `POST /api/salesorders/unpaid` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutLabVantageSalesOrder` | `PUT /api/LabVantage/SalesOrder` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostLabVantageSalesOrder` | `POST /api/LabVantage/SalesOrder` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListOrderLines` | `GET /api/salesorderlines` | ✅ supported | ✅ |  |
| `UnsupportedPostSalesorderlinesArchive` | `POST /api/salesorderlines/Archive` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostSalesorderlinesUnarchive` | `POST /api/salesorderlines/Unarchive` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `CancelOrderLines` | `POST /api/salesorderlines/Cancel` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UnsupportedPostSalesorderlinesGetSalesOrderLineHistory` | `POST /api/salesorderlines/GetSalesOrderLineHistory` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `ListCancelReasons` | `GET /api/salesorderslinecancelreason` | ✅ supported | ✅ |  |
| `ListLineStatuses` | `GET /api/salesorderslinestatus` | ✅ supported | ✅ |  |
| `UnsupportedGetLabVantageSampleSampleId` | `GET /api/LabVantage/Sample/{sampleId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageSamplePerAnalyteFlagsSampleId` | `GET /api/LabVantage/Sample/PerAnalyteFlags/{sampleId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetSampleType` | `GET /api/SampleType` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetShippingFee` | `GET /api/ShippingFee` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetSpecialtySpecialtyId` | `GET /api/Specialty/{SpecialtyId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetSpecialty` | `GET /api/Specialty` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageTestTypeTestTypeIdAndVersion` | `GET /api/LabVantage/TestType/{testTypeIdAndVersion}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageTestTypeAnalytescompoundsTestTypeIdVersion` | `GET /api/LabVantage/TestType/analytescompounds/{testTypeId}/{version}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageTestTypeAnalytesRangeReferenceTestTypeIdVersion` | `GET /api/LabVantage/TestType/analytes_range_reference/{testTypeId}/{version}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageTestTypeSpecsSpecIdAndVersion` | `GET /api/LabVantage/TestType/specs/{specIdAndVersion}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetLabVantageTestTypeSalesorderSalesOrderId` | `GET /api/LabVantage/TestType/salesorder/{salesOrderId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUIGetInitialData` | `GET /api/UI/GetInitialData` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersInvite` | `POST /api/Users/Invite` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersInviteValidate` | `POST /api/Users/Invite/Validate` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersForgotPassword` | `POST /api/Users/ForgotPassword` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersForgotPasswordValidate` | `POST /api/Users/ForgotPassword/Validate` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedDeleteUsersRemove` | `DELETE /api/Users/Remove` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUsersGroupGroupId` | `GET /api/Users/Group/{groupId}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersValidateEmail` | `POST /api/Users/ValidateEmail` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersTriggerWorkflow` | `POST /api/Users/Trigger/Workflow` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersUpdateTermsAndConditionsDate` | `POST /api/Users/UpdateTermsAndConditionsDate` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUsersUpdateHadFirstLogin` | `POST /api/Users/UpdateHadFirstLogin` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUsersIsEmployeeLoginValid` | `GET /api/Users/IsEmployeeLoginValid` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUsersIsValidPortalAccount` | `GET /api/Users/IsValidPortalAccount` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUserGroupsId` | `GET /api/UserGroups/{id}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPutUserGroups` | `PUT /api/UserGroups` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUserGroups` | `POST /api/UserGroups` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUserRoles` | `GET /api/UserRoles` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostUserRoles` | `POST /api/UserRoles` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedGetUserRolesId` | `GET /api/UserRoles/{id}` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostWaystarCreatePayerToken` | `POST /api/waystar/CreatePayerToken` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostWaystarCreditCardTokenPayment` | `POST /api/waystar/CreditCardTokenPayment` | ❌ unsupported | — | Outside the practitioner ordering surface |
| `UnsupportedPostWaystarBulkPayment` | `POST /api/waystar/BulkPayment` | ❌ unsupported | — | Outside the practitioner ordering surface |
