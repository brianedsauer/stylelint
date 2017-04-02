/* @flow */
"use strict"
const fs = require("fs")
const path = require("path")
const ignore = require("ignore")
const formatters = require("./formatters")
const createStylelint = require("./createStylelint")
const globby = require("globby")
const needlessDisables = require("./needlessDisables")

const DEFAULT_IGNORE_FILENAME = ".stylelintignore"
const FILE_NOT_FOUND_ERROR_CODE = "ENOENT"
const ALWAYS_IGNORED_GLOBS = [ "**/node_modules/**", "**/bower_components/**" ]

module.exports = function (options/*: stylelint$standaloneOptions */)/*: Promise<stylelint$standaloneReturnValue>*/ {
  const files = options.files
  const code = options.code
  const codeFilename = options.codeFilename
  const config = options.config
  const configFile = options.configFile
  const configBasedir = options.configBasedir
  const configOverrides = options.configOverrides
  const ignoreDisables = options.ignoreDisables
  const reportNeedlessDisables = options.reportNeedlessDisables
  const formatter = options.formatter
  const syntax = options.syntax
  const customSyntax = options.customSyntax

  // The ignorer will be used to filter file paths after the glob is checked,
  // before any files are actually read
  const ignoreFilePath = options.ignorePath || DEFAULT_IGNORE_FILENAME
  const absoluteIgnoreFilePath = path.isAbsolute(ignoreFilePath)
    ? ignoreFilePath
    : path.resolve(process.cwd(), ignoreFilePath)
  let ignoreText = ""
  try {
    ignoreText = fs.readFileSync(absoluteIgnoreFilePath, "utf8")
  } catch (readError) {
    if (readError.code !== FILE_NOT_FOUND_ERROR_CODE) throw readError
  }
  const ignorer = ignore().add(ignoreText.split(/\r?\n/))

  const isValidCode = typeof code === "string"
  if (!files && !isValidCode || files && (code || isValidCode)) {
    throw new Error("You must pass stylelint a `files` glob or a `code` string, though not both")
  }

  let formatterFunction/*: Function*/
  if (typeof formatter === "string") {
    formatterFunction = formatters[formatter]
    if (formatterFunction === undefined) {
      return Promise.reject(new Error("You must use a valid formatter option: 'json', 'string', 'verbose', or a function"))
    }
  } else if (typeof formatter === "function") {
    formatterFunction = formatter
  } else {
    formatterFunction = formatters.json
  }

  const stylelint = createStylelint({
    config,
    configFile,
    configBasedir,
    configOverrides,
    ignoreDisables,
    reportNeedlessDisables,
    syntax,
    customSyntax,
  })

  if (!files) {
    const absoluteCodeFilename = (codeFilename !== undefined && !path.isAbsolute(codeFilename))
      ? path.join(process.cwd(), codeFilename)
      : codeFilename
    return stylelint._lintSource({
      code,
      codeFilename: absoluteCodeFilename,
    }).then(postcssResult => {
      return stylelint._createStylelintResult(postcssResult)
    }).catch(handleError).then(stylelintResult => {
      return prepareReturnValue([stylelintResult])
    })
  }

  let fileList = files
  if (typeof fileList === "string") {
    fileList = [fileList]
  }
  if (!options.disableDefaultIgnores) {
    fileList = fileList.concat(ALWAYS_IGNORED_GLOBS.map(glob => "!" + glob))
  }

  return globby(fileList).then(filePaths => {
    // The ignorer filter needs to check paths relative to cwd
    filePaths = ignorer.filter(filePaths.map(p => path.relative(process.cwd(), p)))

    if (!filePaths.length) {
      return Promise.all([])
    }

    const getStylelintResults = filePaths.map(filePath => {
      const absoluteFilepath = (!path.isAbsolute(filePath))
        ? path.join(process.cwd(), filePath)
        : filePath
      return stylelint._lintSource({
        filePath: absoluteFilepath,
      }).then(postcssResult => {
        return stylelint._createStylelintResult(postcssResult, filePath)
      }).catch(handleError)
    })

    return Promise.all(getStylelintResults)
  }).then(prepareReturnValue)

  function prepareReturnValue(stylelintResults/*: Array<stylelint$result>*/)/*: stylelint$standaloneReturnValue*/ {
    const errored = stylelintResults.some(result => result.errored)
    const returnValue/*: stylelint$standaloneReturnValue*/ = {
      errored,
      output: formatterFunction(stylelintResults),
      results: stylelintResults,
    }
    if (reportNeedlessDisables) {
      returnValue.needlessDisables = needlessDisables(stylelintResults)
    }
    return returnValue
  }
}

function handleError(error) {
  if (error.name === "CssSyntaxError") {
    return convertCssSyntaxErrorToResult(error)
  } else {
    throw error
  }
}

// By converting syntax errors to stylelint results,
// we can control their appearance in the formatted output
// and other tools like editor plugins can decide how to
// present them, as well
function convertCssSyntaxErrorToResult(error/*: Object*/)/*: stylelint$result*/ {
  if (error.name !== "CssSyntaxError") {
    throw error
  }

  return {
    source: error.file || "<input css 1>",
    deprecations: [],
    invalidOptionWarnings: [],
    errored: true,
    warnings: [{
      line: error.line,
      column: error.column,
      rule: error.name,
      severity: "error",
      text: error.reason + " (" + error.name + ")",
    }],
  }
}
