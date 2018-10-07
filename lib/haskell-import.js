'use babel';

import { CompositeDisposable } from 'atom';
import { exec } from 'child_process';
import SelectList from 'atom-select-list';
import packageConfig from './config-schema.json';
import fs from 'fs';
import path from 'path';

const whatItIs = (toImport) => {
  const startsWithLowerCase = /^[a-z_]/.test(toImport[0]);
  if (toImport.startsWith('data ')) return 'data';
  if (toImport.startsWith('type ')) return 'type';
  if (toImport.startsWith('class ')) return 'typeclass';
  if (toImport.startsWith('newtype ')) return 'newtype';
  if ((startsWithLowerCase || toImport.startsWith('(')) && toImport.includes(' :: ')) return 'function';
  if (!startsWithLowerCase && toImport.includes(' :: ')) return 'constructor';
  return 'unknown';
};

const findConstructorName = (toImport) => (
  toImport.split(' ').reverse().find((s) => s[0].toUpperCase() === s[0])
);

const findFunctionName = (toImport) => {
  const name = toImport.split(' ')[0].trim();
  return name.startsWith('(') ? name.substr(1, name.length - 2) : name;
};

const modifyHoogleResults = (filePath, selectedText, str, local) => (
  str.split('\n').filter(
    (i) => i.trim() !== '' && !i.trim().startsWith('No results found')
  ).map((i) => {
    const split = i.split(/ (.+)/);
    return {
      filePath,
      selectedText,
      local,
      theModule: split[0],
      toImport: split[1]
    };
  }).filter((i) => (
    i.theModule.trim() !== 'module' &&
    i.theModule.trim() !== 'package'
  ))
);

/* global atom */
export default {
  subscriptions: null,
  modal: null,
  listView: null,
  config: packageConfig,

  activate (state) {
    console.log('Activating');

    // Events subscribed to in atom's system can be easily cleaned up with a CompositeDisposable
    this.subscriptions = new CompositeDisposable();

    // Register command that toggles this view
    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'haskell-import:display': () => this.display()
    }));

    const configObserver = atom.config.observe(
      'haskell-import.localHooglePath',
      (value) => {
        console.log('haskell-import detected a config change!', value);
        if (value) {
          this.config = { localHooglePath: value };
        }
      });
    this.subscriptions.add(configObserver);

    this.listView = new SelectList({
      items: [],
      elementForItem: ({
        theModule,
        toImport,
        local
      }, options) => {
        const importType = whatItIs(toImport);
        const li = document.createElement('li');
        const toImportDiv = document.createElement('div');
        const sourceDiv = document.createElement('div');
        const pullRight = document.createElement('div');
        const badge = document.createElement('span');

        li.appendChild(pullRight);
        pullRight.appendChild(badge);
        li.appendChild(toImportDiv);
        li.appendChild(sourceDiv);

        li.className = 'two-lines';

        pullRight.className = 'pull-right';
        badge.className = 'badge';
        badge.textContent = importType;

        toImportDiv.className =
          'primary-line icon icon-' + (local ? 'database' : 'globe');
        toImportDiv.style.fontFamily = atom.config.get('editor.fontFamily') +
            ', Menlo, Consolas, "DejaVu Sans Mono", monospace';
        toImportDiv.textContent = toImport;

        sourceDiv.className = 'secondary-line';
        sourceDiv.textContent = theModule;

        return li;
      },
      didCancelSelection: () => {
        this.modal.hide();
      },
      didConfirmSelection: ({
        filePath,
        selectedText,
        theModule,
        toImport
      }) => {
        this.listView.update({items: []});
        this.modal.hide();
        const importType = whatItIs(toImport);
        const handleByType = new Map([
          ['constructor', () => findConstructorName(toImport)],
          ['function', () => findFunctionName(toImport)],
          ['unknown', () => {
            return atom.notifications.addError(`What the fuck is a ${importType} and hoogle telling me ${toImport}`);
          }
          ]
        ]);
        const exactImport = handleByType.has(importType) ? handleByType.get(importType)() : selectedText;

        if (!exactImport) {
          return atom.notifications.addError(`Unable to extract correct import from ${importType} ${toImport}`);
        }
        const needsConstructor = importType === 'constructor' || importType === 'data';
        const toExec = `hsimport ${needsConstructor ? '-a' : ''} -m '${theModule}' -s '${exactImport}' '${filePath}'`;
        console.log('To exec', toExec);
        editor.save();
        exec(toExec, (a, b, c) => {
          console.log(a, b, c);
        });
      },
      filterKeyForItem: ({ theModule, toImport }) => (
        theModule + ' ' + toImport
      )
    });

    this.modal = atom.workspace.addModalPanel({
      item: this.listView,
      visible: false
    });
  },

  deactivate () {
    this.subscriptions.dispose();
  },

  serialize () {
    return {};
  },

  bigBoy (selectedText, filePath, items) {
    const hoogleMore = `hoogle search --count 1000 "${selectedText}"`;

    this.modal.show();
    this.listView.focus();
    this.listView.update({ items });
    exec(hoogleMore, (err, stdout, stderr) => {
      if (err) {
        atom.notifications.error(err);
        return;
      }
      const newItems = modifyHoogleResults(filePath, selectedText, stdout, false);
      this.listView.update({ items: items.concat(newItems) });
    }
    );
  },

  display () {
    const editor = atom.workspace.getActiveTextEditor();
    const filePath = editor.getPath();
    const dirs = atom.project.getDirectories();
    if (dirs.length > 1) {
      const msg = 'Can not import things with multiple projects open in view.';
      atom.notifications.addError(msg);
      return;
    } else if (dirs.length == 0) {
      const msg = 'There seems to be nothing open. Open a project first and try again.';
      atom.notifications.addError(msg);
    }
    const projectPath = dirs[0].path;

    const hoogleDB = path.join(projectPath, this.config.localHooglePath);
    // select the word
    editor.selectWordsContainingCursors();
    const selectedText = editor.getSelectedText();

    const hoogleCmd = `hoogle search --count 1000 --database "${hoogleDB}" "${selectedText}"`;
    console.log(`Searching for ${selectedText}`);

    exec(hoogleCmd, (error, stdout, stderr) => {
      console.log('error', error, 'stdout', stdout, 'stderr', stderr);
      const items = modifyHoogleResults(filePath, selectedText, stdout, true);
      if (error) {
        atom.notifications.addError(stderr);
      } else {
        this.bigBoy(
          selectedText,
          filePath,
          items
        );
      }
    });
  }
};
