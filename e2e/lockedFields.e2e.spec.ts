/*
Copyright © 2023 SUSE LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * Integration tests that verify that the deployment profile reader is finding locked fields,
 * and that rdctl can't change those locked preferences.
 */

import os from 'os';
import path from 'path';

import { expect, test } from '@playwright/test';

import { NavPage } from './pages/nav-page';
import { verifyNoSystemProfile } from './utils/ProfileUtils';
import {
  createDefaultSettings, createUserProfile, startRancherDesktop, teardown, tool,
} from './utils/TestUtils';

import type { DeploymentProfileType } from '@pkg/config/settings';
import { readDeploymentProfiles } from '@pkg/main/deploymentProfiles';
import { spawnFile } from '@pkg/utils/childProcess';
import { reopenLogs } from '@pkg/utils/logging';

import type { ElectronApplication, BrowserContext, Page } from '@playwright/test';

test.describe('Locked fields', () => {
  test.skip(process.platform === 'win32', 'TODO: Implement testing on Windows');
  let electronApp: ElectronApplication;
  let context: BrowserContext;
  let page: Page;
  const appPath = path.join(__dirname, '../');
  let deploymentProfile: DeploymentProfileType|null = null;

  function rdctlPath() {
    return path.join(appPath, 'resources', os.platform(), 'bin', os.platform() === 'win32' ? 'rdctl.exe' : 'rdctl');
  }

  async function rdctl(commandArgs: string[]): Promise< { stdout: string, stderr: string, error?: any }> {
    try {
      return await spawnFile(rdctlPath(), commandArgs, { stdio: 'pipe' });
    } catch (err: any) {
      return {
        stdout: err?.stdout ?? '', stderr: err?.stderr ?? '', error: err,
      };
    }
  }

  async function saveUserProfile() {
    // Ignore any errors in the existing profile, but it means they won't be saved.
    try {
      deploymentProfile = await readDeploymentProfiles();
    } catch { }
  }

  async function restoreUserProfile() {
    await createUserProfile(deploymentProfile?.defaults ?? null, deploymentProfile?.locked ?? null);
  }

  test.describe.configure({ mode: 'serial' });
  const lockedK8sVersion = '1.26.3';
  const proposedK8sVersion = '1.26.1';

  test.beforeAll(async() => {
    await tool('rdctl', 'factory-reset', '--verbose');
    reopenLogs();
  });

  test.afterAll(async() => {
    await restoreUserProfile();
  });

  test.beforeAll(async() => {
    createDefaultSettings({ containerEngine: { allowedImages: { enabled: true, patterns: ['a', 'b', 'c', 'e'] } } });
    await saveUserProfile();
    await createUserProfile(
      { containerEngine: { allowedImages: { enabled: true } } },
      { containerEngine: { allowedImages: { enabled: true, patterns: ['c', 'd', 'f'] } }, kubernetes: { version: lockedK8sVersion } },
    );
    electronApp = await startRancherDesktop(__filename);
    context = electronApp.context();

    await context.tracing.start({
      screenshots: true,
      snapshots:   true,
    });
    page = await electronApp.firstWindow();
  });

  test.afterAll(async() => {
    await teardown(electronApp, __filename);
    await tool('rdctl', 'factory-reset', '--verbose');
    reopenLogs();
  });

  test('should start up', async() => {
    const navPage = new NavPage(page);

    await navPage.progressBecomesReady();
    await expect(navPage.progressBar).toBeHidden();
  });

  test('should not allow a locked field to be changed via rdctl set', async() => {
    const { stdout, stderr, error } = await rdctl(['list-settings']);
    const skipReasons = await verifyNoSystemProfile();

    test.skip(skipReasons.length > 0, skipReasons.join('\n'));
    expect({ stderr, error }).toEqual({ error: undefined, stderr: '' });
    const originalSettings = JSON.parse(stdout);
    const newEnabled = !originalSettings.containerEngine.allowedImages.enabled;

    expect(originalSettings.containerEngine.allowedImages.patterns.sort()).toEqual(['c', 'd', 'f']);
    await expect(rdctl(['set', `--container-engine.allowed-images.enabled=${ newEnabled }`]))
      .resolves.toMatchObject({
        stdout: '',
        stderr: expect.stringContaining(`field "containerEngine.allowedImages.enabled" is locked`),
      });
    await expect(rdctl(['set', `--kubernetes.version=${ proposedK8sVersion }`]))
      .resolves.toMatchObject({
        stdout: '',
        stderr: expect.stringContaining(`field "kubernetes.version" is locked`),
      });
    await expect(rdctl(['set', `--kubernetes.version=${ lockedK8sVersion }`]))
      .resolves.toMatchObject({
        stdout: expect.stringContaining('Status: no changes necessary.'),
        stderr: '',
      });
  });
});
