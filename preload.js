'use strict';
/* پل امن contextBridge: فقط متدهای مشخص‌شده به رندرر داده می‌شوند (بدون دسترسی به Node/Electron).
   هر متد دقیقاً یک کانال IPC را صدا می‌زند؛ کنترل دسترسی در main (lib/service.js) انجام می‌شود، نه اینجا. */
const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = {
  authState: 'auth:state', brandingGet: 'branding:get', branchesStats: 'branches:stats', transferRun: 'transfer:run', brandingApply: 'branding:apply', authSetup: 'auth:setup', authLogin: 'auth:login', authLogout: 'auth:logout', authMe: 'auth:me',
  authChangePassword: 'auth:changePassword',
  load: 'db:load', save: 'db:save', log: 'db:log', readLogs: 'logs:read',
  usersSave: 'users:save', usersDelete: 'users:delete', usersSetPassword: 'users:setPassword',
  permsMatrix: 'perms:matrix', permsSet: 'perms:set',
  recoveryRegenerate: 'recovery:regenerate', recoveryReset: 'recovery:reset',
  backupCreate: 'backup:create', backupList: 'backup:list', backupInfo: 'backup:info', backupVerify: 'backup:verify',
  backupRestore: 'backup:restore', backupSetConfig: 'backup:setConfig', backupChooseDir: 'backup:chooseDir',
  backupPickFile: 'backup:pickFile', backupOpenFolder: 'backup:openFolder',
  fileSave: 'file:save', fileGet: 'file:get', fileDelete: 'file:delete',
  saveText: 'dialog:saveText', printPDF: 'print:pdf', printOffice: 'print:office', printSaveFiles: 'print:saveFiles', meSetPrefs: 'me:setPrefs', showInFolder: 'file:showInFolder'
};
const api = { isElectron: true };
Object.keys(CHANNELS).forEach((name) => { api[name] = (...a) => ipcRenderer.invoke(CHANNELS[name], ...a); });
contextBridge.exposeInMainWorld('eduCenterAPI', Object.freeze(api));
