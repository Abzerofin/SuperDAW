import { ProjectStore } from '@core/state/store'
import { newId } from '@core/model/ids'
import { createDemoProject } from './demoProject'

/**
 * The renderer's single project store instance. The user id is a random
 * per-app-run peer identity (no accounts, by design): it only needs to be
 * unique within a collaboration session.
 */
export const projectStore = new ProjectStore(createDemoProject(), newId('usr'))
