import * as React from 'react'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { IRefCheck } from '../../lib/ci-checks/ci-checks'
import { CICheckRunList } from './ci-check-run-list'
import { GitHubRepository } from '../../models/github-repository'
import { Dispatcher } from '../dispatcher'
import {
  APICheckConclusion,
  APICheckStatus,
  IAPICheckSuite,
} from '../../lib/api'
import { Octicon } from '../octicons'
import * as OcticonSymbol from './../octicons/octicons.generated'
import { Row } from '../lib/row'
import { encodePathAsUrl } from '../../lib/path'
import { offsetFromNow } from '../../lib/offset-from'

const BlankSlateImage = encodePathAsUrl(
  __dirname,
  'static/empty-no-pull-requests.svg'
)

interface ICICheckRunRerunDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: GitHubRepository

  /** List of all the check runs (some of which are not rerunnable) */
  readonly checkRuns: ReadonlyArray<IRefCheck>

  /** The git reference of the pr */
  readonly prRef: string

  /** Whether to only rerun failed checks */
  readonly failedOnly: boolean

  readonly onDismissed: () => void
}

interface ICICheckRunRerunDialogState {
  readonly loadingCheckSuites: boolean
  readonly loadingRerun: boolean
  readonly rerunnable: ReadonlyArray<IRefCheck>
  readonly nonRerunnable: ReadonlyArray<IRefCheck>
}

/**
 * Dialog that informs the user of which jobs will be rerun
 */
export class CICheckRunRerunDialog extends React.Component<
  ICICheckRunRerunDialogProps,
  ICICheckRunRerunDialogState
> {
  public constructor(props: ICICheckRunRerunDialogProps) {
    super(props)
    this.state = {
      loadingCheckSuites: true,
      loadingRerun: false,
      rerunnable: [],
      nonRerunnable: [],
    }
    this.determineRerunnability()
  }

  private onSubmit = async () => {
    const { dispatcher, repository, prRef } = this.props
    this.setState({ loadingRerun: true })
    await dispatcher.rerequestCheckSuites(
      repository,
      this.state.rerunnable,
      this.props.failedOnly
    )
    await dispatcher.manualRefreshSubscription(
      repository,
      prRef,
      this.state.rerunnable
    )
    dispatcher.recordRerunChecks()
    this.props.onDismissed()
  }

  private determineRerunnability = async () => {
    const checkRunsToConsider = this.props.failedOnly
      ? this.props.checkRuns.filter(
          cr => cr.conclusion === APICheckConclusion.Failure
        )
      : this.props.checkRuns

    // Get unique set of check suite ids
    const checkSuiteIds = new Set(
      checkRunsToConsider.map(cr => cr.checkSuiteId)
    )

    const checkSuitesPromises = new Array<Promise<IAPICheckSuite | null>>()

    for (const id of checkSuiteIds) {
      if (id === null) {
        continue
      }
      checkSuitesPromises.push(
        this.props.dispatcher.fetchCheckSuite(this.props.repository, id)
      )
    }

    const rerequestableCheckSuiteIds: number[] = []
    for (const cs of await Promise.all(checkSuitesPromises)) {
      if (cs === null) {
        continue
      }

      const createdAt = Date.parse(cs.created_at)
      if (
        cs.rerequestable &&
        createdAt > offsetFromNow(-30, 'days') && // Must be less than a month old
        cs.status === APICheckStatus.Completed // Must be completed
      ) {
        rerequestableCheckSuiteIds.push(cs.id)
      }
    }

    const rerunnable = checkRunsToConsider.filter(
      cr =>
        cr.checkSuiteId !== null &&
        rerequestableCheckSuiteIds.includes(cr.checkSuiteId)
    )
    const nonRerunnable = this.props.checkRuns.filter(
      cr =>
        cr.checkSuiteId === null ||
        !rerequestableCheckSuiteIds.includes(cr.checkSuiteId) ||
        (this.props.failedOnly && cr.conclusion === APICheckConclusion.Failure)
    )

    this.setState({ loadingCheckSuites: false, rerunnable, nonRerunnable })
  }

  private renderRerunnableJobsList = () => {
    if (this.state.loadingCheckSuites) {
      return (
        <div className="loading-rerun-checks">
          <img src={BlankSlateImage} className="blankslate-image" />
          <div className="title">Please wait</div>
          <div className="call-to-action">
            Determining which checks can be re-run.
          </div>
        </div>
      )
    }

    return (
      <div className="ci-check-run-list check-run-rerun-list">
        {this.state.rerunnable.length > 0 ? (
          <CICheckRunList
            checkRuns={this.state.rerunnable}
            loadingActionLogs={false}
            loadingActionWorkflows={false}
            notExpandable={true}
          />
        ) : null}
      </div>
    )
  }

  private renderRerunInfo = () => {
    if (
      this.state.loadingCheckSuites ||
      this.state.nonRerunnable.length === 0
    ) {
      return null
    }

    /**
     * Verbiage from dotcom:
     * Single Job: "A new attempt of this workflow will be started, including macOS x64 and dependents"
     * Failed Jobs: "A new attempt of this workflow will be started, including all failed jobs and dependents"
     * */

    const pluralize = `check${this.state.nonRerunnable.length !== 1 ? 's' : ''}`
    const verb = this.state.nonRerunnable.length !== 1 ? 'are' : 'is'
    const warningPrefix =
      this.state.rerunnable.length === 0
        ? `There are no checks that can be re-run`
        : `There ${verb} ${this.state.nonRerunnable.length} ${pluralize} that cannot be re-run`
    return (
      <Row className="non-re-run-info warning-helper-text">
        <Octicon symbol={OcticonSymbol.alert} />

        {`${warningPrefix}. A check run cannot be re-run if the check is more than one month old,
          the check has not completed, or the check is not configured to be
          re-run.`}
      </Row>
    )
  }

  public render() {
    const failed = this.props.failedOnly
      ? __DARWIN__
        ? 'Failed '
        : 'failed '
      : ''
    return (
      <Dialog
        id="rerun-check-runs"
        title={__DARWIN__ ? `Re-run ${failed}Checks` : `Re-run ${failed}checks`}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={this.state.loadingCheckSuites || this.state.loadingRerun}
      >
        <DialogContent>{this.renderRerunnableJobsList()}</DialogContent>
        <DialogFooter>
          {this.renderRerunInfo()}
          <OkCancelButtonGroup
            okButtonText={
              __DARWIN__ ? `Re-run ${failed}Checks` : `Re-run ${failed}checks`
            }
            okButtonDisabled={this.state.rerunnable.length === 0}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}
