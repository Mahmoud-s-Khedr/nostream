import { createMaintenanceService } from './maintenance-service-factory'
import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'
import { getMasterDbClient } from '../database/client'
import { MaintenanceWorker } from '../app/maintenance-worker'
import { Nip05VerificationRepository } from '../repositories/nip05-verification-repository'
import { SearchMetadataRepository } from '../repositories/search-metadata-repository'

export const maintenanceWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const nip05VerificationRepository = new Nip05VerificationRepository(dbClient)
  const searchMetadataRepository = new SearchMetadataRepository(dbClient)
  return new MaintenanceWorker(
    process,
    createPaymentsService(),
    createMaintenanceService(),
    createSettings,
    nip05VerificationRepository,
    searchMetadataRepository,
  )
}
