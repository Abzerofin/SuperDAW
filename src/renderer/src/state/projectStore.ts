import { ProjectStore } from '@core/state/store'
import { createDemoProject } from './demoProject'

/**
 * The renderer's single project store instance. 'you' is a placeholder
 * user id until the collaboration milestone introduces real peer identity.
 */
export const projectStore = new ProjectStore(createDemoProject(), 'you')
