/*
 * Edit Desktop Files for GNOME Shell 45+
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as St from 'gi://St';
import Clutter from 'gi://Clutter';
import { Extension, InjectionManager, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';


/*
 * Manages intermediate files for safe desktop entry editing.
 * Handles file lifecycle: creation, validation, application of changes.
 */ // @todo: рефакторинг. Переместит класс в модуль
class EditingFileManager {
    // FIXME: Add more robust file operations with better error handling
    // FIXME: Ensure all file streams are properly closed
    // TODO: Add limit for simultaneously edited files
    // TODO: Add fallback behavior when desktop-file-validate is not available
    // TODO: Improve desktop-file-validate output parsing for better error reporting
    // TODO: Consider adding tracking of multiple editing sessions for the same desktop file
    constructor() {
        this._extension = extension;  // Need access to extension.path
        this._editingFiles = new Set();
        this._originalFiles = new Map();  // intermediate file -> original file
    }

    /*
     * Formats error messages as EDF comments
     * 
     * @param {string[]} errors - Array of error messages
     * @returns {string} Formatted error messages with EDF comments
     */
    _formatErrorComments(errors) {
        return this._formatAsEdfComments(errors.join('\n'), 'ERROR:');
    }

    /*
     * Formats help text as EDF comments and adds original file name
     * Inserts file name as second line after header
     * 
     * @param {string} text - Raw help text
     * @param {string} file_name - Path to original .desktop file
     * @returns {string} Formatted help text with EDF comments
     */
    _formatHelpComments(text, file_name) {
        // Формируем helpText
        // Вставляем имя файла второй строкой
        const lines = this._formatAsEdfComments(text).split('\n');
        lines.splice(1, 0, `#EDF# @File: ${file_name}`);

        return lines.join('\n');
    }

    /*
     * Formats text as EDF comments by adding #EDF# prefix to each line
     * 
     * @param {string} text - Raw help text
     * @returns {string} Text formatted as EDF comments
     */
    _formatAsEdfComments(text, prefix = "") {
        return text.split('\n')
            .map(line => line.trim() ? `#EDF#${prefix} ` + line : '#EDF#')
            .join('\n') + '\n\n';
    }

    /*
     * Filters out EDF comments from text
     * 
     * @param {string} text - Text to filter
     * @returns {string} Text without EDF comments
     */
    _filterEdfComments(text) {
        return text.split('\n')
            .filter(line => !line.startsWith('#EDF#'))
            .join('\n');
    }

    /*
     * Loads default help text from data/fallback-help-text.txt
     * Called only when localized text is not available
     * 
     * @returns {string} Default help text in English
     */
    _loadDefaultHelpText() {
        try {
            const dataDir = this._extension.path + '/data';
            const helpTextPath = GLib.build_filenamev([dataDir, 'fallback-help-text.txt']);
            const [success, content] = GLib.file_get_contents(helpTextPath);

            if (!success) {
                logError(new Error('Failed to read fallback-help-text.txt'));
                return '';
            }

            return new TextDecoder().decode(content);
        } catch (error) {
            logError(error, 'Error loading help text');
            return '';
        }
    }

    /*
     * Gets help text with fallback to default English version
     * 
     * @returns {string} Help text in current locale or English
     */
    _getHelpText() {
        let text = _('<help_text>');

        if (text === '<help_text>') {
            text = this._loadDefaultHelpText();
        }

        return text;
    }

    /*
     * Creates intermediate file for editing desktop entry.
     * Adds help comments and preserves original content.
     * 
     * @param {string} originalPath - Path to original .desktop file
     * @returns {Object} Created file info or null on error
     */
    createForEditing(originalPath) {
        const originalFile = Gio.File.new_for_path(originalPath);
        const intermediatePath = GLib.build_filenamev([GLib.get_tmp_dir(),
        `edf-${GLib.uuid_string_random()}.desktop`]);
        const intermediateFile = Gio.File.new_for_path(intermediatePath);

        this._editingFiles.add(intermediateFile);
        this._originalFiles.set(intermediateFile, originalFile);

        try {
            // Write help text first
            const helpText = this._getHelpText();
            if (helpText) {
                const formattedHelp = this._formatHelpComments(helpText, originalFile.get_basename());
                intermediateFile.replace_contents(
                    new TextEncoder().encode(formattedHelp),
                    null,
                    false,
                    Gio.FileCreateFlags.NONE,
                    null
                );

                // Append original content
                const [success, contents] = originalFile.load_contents(null);
                if (success) {
                    const stream = intermediateFile.append_to(
                        Gio.FileCreateFlags.NONE,
                        null
                    );
                    stream.write(contents, null);
                    stream.close(null);
                }
                // @todo: else { fail }
            }

            this._editingFiles.add(intermediateFile);

            return {
                intermediatePath: intermediatePath,
                intermediateFile: intermediateFile,
                originalFile
            };
        } catch (error) {
            logError(error, 'Failed to create intermediate file');
            Main.notify(_('Edit Desktop Files'),
                _('Cannot create intermediate file for editing'));
            return null;
        }
    }

    /*
     * Validates file using GLib.KeyFile
     * Provides basic structure validation and syntax checking
     * 
     * @param {Gio.File} file - File to validate
     * @returns {Object} Validation result and errors if any
     */
    _validateWithKeyFile(file) {
        const keyFile = new GLib.KeyFile();

        try {
            const [success, contents] = file.load_contents(null);
            if (!success) {
                return {
                    isValid: false,
                    errors: ['Failed to read file contents']
                };
            }

            keyFile.load_from_bytes(new GLib.Bytes(contents),
                GLib.KeyFileFlags.KEEP_COMMENTS | GLib.KeyFileFlags.KEEP_TRANSLATIONS);

            return {
                isValid: true,
                errors: []
            };

        } catch (error) {
            // GLib.KeyFile provides localized error messages
            return {
                isValid: false,
                errors: [error.message]
            };
        }
    }

    /*
     * Validates file using Gio.DesktopAppInfo
     * Primary validation for desktop entry specification compliance
     * 
     * @param {Gio.File} file - File to validate
     * @returns {Object} Validation result
     */
    _validateWithDesktopAppInfo(file) {
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(file.get_path());

            // If appInfo is null - desktop entry is not valid
            if (!appInfo) {
                return {
                    isValid: false,
                    needDetails: true  // Signal that we need desktop-file-validate
                };
            }

            return {
                isValid: true,
                needDetails: false
            };

        } catch (error) {
            return {
                isValid: false,
                needDetails: true,
                errors: [error.message]
            };
        }
    }

    /*
     * Validates file using desktop-file-validate utility
     * Used for detailed error reporting when DesktopAppInfo validation fails
     * 
     * @param {Gio.File} file - File to validate
     * @returns {Object} Validation result with detailed error messages
     */
    _validateWithDesktopFileValidate(file) {
        try {
            // Prepare command
            const filePath = file.get_path();
            const [success, stdout, stderr, exitCode] = GLib.spawn_command_line_sync(
                `desktop-file-validate "${filePath}"`
            );

            if (!success) {
                return {
                    isValid: false,
                    errors: ['Failed to run desktop-file-validate']
                };
            }

            // desktop-file-validate returns:
            // - exit code 0 if file is valid
            // - exit code 1 if validation errors were found
            // - error messages in stderr
            const errors = new TextDecoder().decode(stderr)
                .split('\n')
                .filter(line => line.trim().length > 0);

            return {
                isValid: exitCode === 0,
                errors: errors
            };

        } catch (error) {
            return {
                isValid: false,
                errors: ['desktop-file-validate is not available']
            };
        }
    }

    /*
     * Recreates editing file with error messages as EDF comments
     * Preserves original content and adds validation errors
     * 
     * @param {Gio.File} file - File to recreate
     * @param {string[]} errors - Error messages to add
     * @returns {boolean} Success status
     */
    _recreateFileWithErrors(file, errors) {
        try {
            // Get current content - it contains user changes!
            const [success, contents] = file.load_contents(null);
            if (!success) {
                return false;
            }

            // Get user content without EDF comments
            const userContent = this._filterEdfComments(
                new TextDecoder().decode(contents)
            );

            // Write help text first
            const helpText = this._formatHelpComments(this._getHelpText(),
                this._originalFiles.get(file).get_basename());

            file.replace_contents(
                new TextEncoder().encode(helpText),
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );

            // Append error messages
            const errorText = this._formatErrorComments(errors);
            const stream = file.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            stream.write(new TextEncoder().encode(errorText), null);

            // Append user's content
            stream.write(new TextEncoder().encode(userContent), null);
            stream.close(null);

            return true;
        } catch (error) {
            logError(error, 'Failed to recreate file with error messages');
            return false;
        }
    }

    /*
     * Validates edited desktop entry file
     * Uses multiple validation steps:
     * 1. Basic structure check with GLib.KeyFile
     * 2. Desktop entry validation with Gio.DesktopAppInfo
     * 3. Detailed error reporting with desktop-file-validate if needed
     * 
     * @param {Gio.File} file - File to validate
     * @returns {boolean} Validation success status
     */
    validateFile(file) {
        // First check with GLib.KeyFile
        const keyFileResult = this._validateWithKeyFile(file);
        if (!keyFileResult.isValid) {
            // Recreation with KeyFile errors
            this._recreateFileWithErrors(file, keyFileResult.errors);
            return false;
        }

        // Then check with DesktopAppInfo
        const desktopResult = this._validateWithDesktopAppInfo(file);
        if (!desktopResult.isValid) {
            if (desktopResult.needDetails) {
                // Get detailed errors with desktop-file-validate
                const validateResult = this._validateWithDesktopFileValidate(file);
                this._recreateFileWithErrors(file, validateResult.errors);
            } else if (desktopResult.errors) {
                this._recreateFileWithErrors(file, desktopResult.errors);
            }
            return false;
        }

        return true;
    }

    /*
     * Checks if file contains only comments or is empty
     * Used to detect if user wants to remove desktop entry
     * 
     * @param {Gio.File} file - File to check
     * @returns {boolean} True if file contains only comments or is empty
     */
    isEmptyContent(file) {
        try {
            const [success, contents] = file.load_contents(null);
            if (!success) {
                return false;
            }

            // Get content without EDF comments
            const content = this._filterEdfComments(
                new TextDecoder().decode(contents)
            );

            // Check if remaining content contains only whitespace or is empty
            return content.trim().length === 0;

        } catch (error) {
            logError(error, 'Failed to check if file is empty');
            return false;
        }
    }

    /*
     * Removes specific editing file
     * 
     * @param {Gio.File} file - File to remove
     */
    remove(file) {
        if (file && this._editingFiles.has(file)) {
            this._editingFiles.delete(file);
            this._originalFiles.delete(file);
            try {
                file.delete(null);
                this._editingFiles.delete(file);
            } catch (error) {
                logError(error, 'Failed to delete editing file');
            }
        }
    }

    /*
     * Removes all editing files and cleans up resources
     */
    cleanup() {
        for (const file of this._editingFiles) {
            try {
                file.delete(null);
            } catch (error) {
                logError(error, 'Failed to delete editing file during cleanup');
            }
        }
        this._editingFiles.clear();
        this._originalFiles.clear();
    }
}

/*
* The Edit Desktop Files extension provides users with an "Edit" button on the pop-up menu
* that appears when right-clicking an app icon in the app grid or dash.
* When clicked, the backing desktop file is opened in an editor.
*
* This is done by injecting a function to run prior to the gnome-shell AppMenu's 'open' method.
* The function inserts a new "Edit" MenuItem that, when clicked, either opens the backing desktop
* file with the GNOME Text Editor (default) or a custom command supplied by the user.
*/
export default class EditDesktopFilesExtension extends Extension {

    /**
     * Shows modal dialog to confirm action
     * Uses standard GNOME Shell modal dialog
     * 
     * @param {string} title - Dialog title
     * @param {string} message - Dialog message 
     * @param {string} confirmLabel - Label for confirm button
     * @param {string} cancelLabel - Label for cancel button
     * @returns {Promise<boolean>} True if confirmed, False if canceled
     */
    async _showConfirmDialog(title, message, confirmLabel, cancelLabel) {
        try {
            const dialog = new ModalDialog.ModalDialog({
                destroyOnClose: true
            });

            dialog.contentLayout.add(new St.Label({
                text: message,
                style_class: 'header'
            }));

            dialog.addButton({
                label: cancelLabel,
                action: () => {
                    dialog.close();
                    dialog._deferred.resolve(false);
                },
                key: Clutter.KEY_Escape
            });

            dialog.addButton({
                label: confirmLabel,
                action: () => {
                    dialog.close();
                    dialog._deferred.resolve(true);
                }
            });

            dialog._deferred = new Promise((resolve) => {
                dialog._deferred = { resolve };
            });

            dialog.open();
            return dialog._deferred;

        } catch (error) {
            logError(error, 'Failed to show confirmation dialog');
            return false;
        }
    }

    /*
     * Applies validated changes to local applications directory
     * Copies edited file to ~/.local/share/applications
     * 
     * @param {Gio.File} editedFile - Validated editing file
     * @returns {boolean} True if changes were applied successfully
     */
    applyChanges(editedFile) {
        try {
            const originalFile = this._originalFiles.get(editedFile);
            if (!originalFile) {
                logError(new Error('No original file found for edited file'));
                return false;
            }

            // Get content without EDF comments
            const [success, contents] = editedFile.load_contents(null);
            // if (!success) {
            //     return false;
            // }
            const content = this._filterEdfComments(new TextDecoder().decode(contents));

            // Prepare path in local applications directory
            const localPath = GLib.build_filenamev([
                GLib.get_user_data_dir(),
                'applications',
                originalFile.get_basename()
            ]);
            const localFile = Gio.File.new_for_path(localPath);

            // Create parent directory if it doesn't exist
            const parent = localFile.get_parent();
            if (!parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }

            // Write the filtered content
            localFile.replace_contents(
                new TextEncoder().encode(content),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            return true;

        } catch (error) {
            logError(error, 'Failed to apply changes');
            return false;
        }
    }

    /*
     * Launches editor for desktop entry and waits for completion
     * Uses Gio.Subprocess instead of GLib.spawn_command_line_async because:
     * - It's safer and cleaner way to handle subprocesses
     * - Provides proper process completion tracking
     * - Handles cleanup automatically
     * - Better error handling
     * 
     * @param {Object} fileInfo - Information about file to edit
     */
    async _launchEditor(fileInfo) {
        try {
            while (true) {
                const command = ['gapplication', 'launch', 'org.gnome.TextEditor', fileInfo.intermediatePath];

                // Use custom command if configured
                if (this._settings.get_boolean("use-custom-edit-command")) {
                    const customCommand = this._settings.get_string("custom-edit-command");
                    if (customCommand.indexOf('%U') !== -1) {
                        command = customCommand.replace('%U', fileInfo.intermediatePath).split(' ');
                    } else {
                        console.warn(`${this.metadata.name}: Custom edit command is missing '%U', falling back to default GNOME Text Editor`);
                    }
                }

                const proc = Gio.Subprocess.new(
                    command,
                    Gio.SubprocessFlags.STDOUT_SILENCE |     // Don't pollute shell output
                    Gio.SubprocessFlags.STDERR_SILENCE |     // with editor messages
                    Gio.SubprocessFlags.SEARCH_PATH_FROM_ENVP // Use launcher environment PATH
                );

                // Wait for editor to close
                await proc.wait_check_async(null);

                // First check if file is empty
                // Check if file is empty (contains only comments)
                if (this._editingFileManager.isEmptyContent(fileInfo.intermediateFile)) {
                    const confirmed = await this._showConfirmDialog(
                        _("Remove Desktop Entry"),
                        _("This entry appears to be empty. Do you want to remove it?"),
                        _("Remove"),
                        _("Cancel")
                    );

                    if (confirmed) {
                        // Get path to local desktop entry
                        const localPath = GLib.build_filenamev([
                            GLib.get_user_data_dir(),
                            'applications',
                            fileInfo.originalFile.get_basename()
                        ]);
                        const localFile = Gio.File.new_for_path(localPath);

                        try {
                            // Move to trash if exists
                            if (localFile.query_exists(null)) {
                                localFile.trash(null);
                            }

                            // Cleanup editing file
                            this._editingFileManager.remove(fileInfo.intermediateFile);

                        } catch (error) {
                            logError(error, 'Failed to move file to trash');
                        }
                    } else {
                        // User canceled - just remove editing file
                        this._editingFileManager.remove(fileInfo.intermediateFile);
                    }
                    return;
                }

                // Editor closed - validate edited file
                if (this._editingFileManager.validateFile(fileInfo.intermediateFile)) {
                    break;  // File is valid, exit loop
                }

                // File is not valid - ask user what to do
                const continueEditing = await this._showConfirmDialog(
                    _("Validation Error"),
                    _("The desktop entry contains errors. Do you want to continue editing?"),
                    _("Continue Editing"),
                    _("Discard Changes")
                );

                if (!continueEditing) {
                    this._editingFileManager.remove(fileInfo.intermediateFile);
                    return;
                }

                // Loop continues - reopen editor

            }

            // File is valid - apply changes
            if (!this._editingFileManager.applyChanges(fileInfo.intermediateFile)) {
                Main.notify(_('Edit Desktop Files'),
                    _('Failed to save changes'));
            }

            // Cleanup intermediate file
            this._editingFileManager.remove(fileInfo.intermediateFile);

        } catch (error) {
            logError(error, 'Failed to handle editor process');
        }
    }

    enable() {
        this._settings = this.getSettings();
        this._injectionManager = new InjectionManager();
        this._modifiedMenus = []
        this._addedMenuItems = []

        // Call gettext here explicitly so "Edit" can be localized as part of this extension
        let localizedEditStr = gettext('Edit')

        // Extend the AppMenu's 'open' method to add an 'Edit' MenuItem
        // See: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/appMenu.js
        this._injectionManager.overrideMethod(AppMenu.prototype, 'open',
            originalMethod => {
                const metadata = this.metadata;
                const settings = this.getSettings();
                const modifiedMenus = this._modifiedMenus;
                const addedMenuItems = this._addedMenuItems;

                return function (...args) {

                    // Suitably awful name to ensure it doesn't conflict with an existing/future property
                    if (this._editDesktopFilesExtensionMenuItem) {
                        return originalMethod.call(this, ...args);
                    }

                    // Don't display the menu item for windows not backed by a desktop file
                    const appInfo = this._app?.app_info;
                    if (!appInfo) {
                        return originalMethod.call(this, ...args);
                    }

                    // Add the 'Edit' MenuItem
                    let editMenuItem = this.addAction(localizedEditStr, () => {
                        // Create editing file manager if not exists
                        if (!this._editingFileManager) {
                            this._editingFileManager = new EditingFileManager(this);
                        }

                        const fileInfo = this._editingFileManager.createForEditing(appInfo.filename);
                        if (!fileInfo) {
                            return;
                        }

                        // Using async/await with Gio.Subprocess instead of direct GLib.spawn_command_line_async
                        // for proper process handling and completion tracking
                        this._launchEditor(fileInfo);

                        if (Main.overview.visible) {
                            Main.overview.hide();
                        }
                    });

                    // Move the 'Edit' MenuItem to be after the 'App Details' MenuItem
                    let menuItems = this._getMenuItems()
                    for (let i = 0; i < menuItems.length; i++) {
                        let menuItem = menuItems[i]
                        if (menuItem.label) {
                            if (menuItem.label.text == _('App Details')) {
                                this.moveMenuItem(editMenuItem, i + 1)
                                break;
                            }
                        }
                    }

                    // Keep track of menus that have been affected so they can be cleaned up later
                    this._editDesktopFilesExtensionMenuItem = editMenuItem
                    modifiedMenus.push(this)
                    addedMenuItems.push(editMenuItem)

                    return originalMethod.call(this, ...args);
                };
            }
        );
    }

    disable() {
        this._settings = null
        this._injectionManager.clear();
        this._injectionManager = null;
        this.removeAllMenuItems()
        this._addedMenuItems = null
        this._modifiedMenus = null
    }

    removeAllMenuItems() {
        // Delete the added properties
        for (let menu of this._modifiedMenus) {
            delete menu._editDesktopFilesExtensionMenuItem
        }

        // Delete all added MenuItems
        for (let menuItem of this._addedMenuItems) {
            menuItem.destroy();
        }

        this._addedMenuItems = []
        this._modifiedMenus = []
    }
}
