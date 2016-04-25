import { log, debug } from './log';

class FakeFile {

  constructor(data) {
    this.data = data;
  }

  getContentsAsString() {
    return this.data.contents;
  }

  getPackageName() {
    return this.data.packageName;
  }

  getPathInPackage() {
    return this.data.pathInPackage;
  }

  getFileOptions() {
    return this.data.fileOptions;
  }

  getDisplayPath() {
    return this.data.displayPath;
  }

  getExtension() {
    return this.data.extension;
  }

  getBasename() {
    return this.data.basename;
  }

  getArch() {
    return 'web.browser';
  }

  getSourceHash() {
    return this.data.sourceHash;
  }

  addJavaScript(js) {
    // no-op
    log('addJavaScript not overriden');
  }

  error(error) {
    log(error);
  }
}

export default FakeFile;
