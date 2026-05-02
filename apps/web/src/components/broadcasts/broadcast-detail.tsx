'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api, type ApiBroadcast, type BroadcastInsight } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import FlexPreviewComponent from '@/components/flex-preview'
import TestSendSection from '@/components/broadcasts/test-send-section'
import ProgressBar from '@/components/broadcasts/progress-bar'
import SendConfirmDialog from '@/components/broadcasts/send-confirm-dialog'
import SegmentBuilder from '@/components/broadcasts/segment-builder'
import type { Tag } from '@line-crm/shared'

interface BroadcastDetailProps {
  broadcastId: string
}

export default function BroadcastDetail({ broadcastId }: BroadcastDetailProps) {
  const id = broadcastId
  const router = useRouter()
  const { selectedAccount } = useAccount()
  const [broadcast, setBroadcast] = useState<ApiBroadcast | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [sending, setSending] = useState(false)
  const [insight, setInsight] = useState<BroadcastInsight | null>(null)
  const [targetCount, setTargetCount] = useState<number | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [showSegmentBuilder, setShowSegmentBuilder] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [res, tagsRes] = await Promise.all([
        api.broadcasts.get(id),
        api.tags.list(),
      ])
      if (res.success && res.data) {
        setBroadcast(res.data)
        if (res.data.totalCount > 0) setTargetCount(res.data.totalCount)
      } else {
        setError('配信が見つかりません')
      }
      if (tagsRes.success) setTags(tagsRes.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // Poll progress while sending
  useEffect(() => {
    if (broadcast?.status !== 'sending') return
    const interval = setInterval(async () => {
      const res = await api.broadcasts.getProgress(id)
      if (res.success && res.data) {
        setBroadcast(prev => prev ? {
          ...prev,
          status: res.data!.status as ApiBroadcast['status'],
          totalCount: res.data!.totalCount,
          successCount: res.data!.successCount,
        } : prev)
        if (res.data.status === 'sent') {
          clearInterval(interval)
          load()
        }
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [broadcast?.status, id, load])

  // Load insight for sent broadcasts
  useEffect(() => {
    if (broadcast?.status !== 'sent') return
    api.broadcasts.getInsight(id).then(res => {
      if (res.success && res.data) setInsight(res.data)
    })
  }, [broadcast?.status, id])

  const handleSend = async () => {
    setShowConfirm(false)
    setSending(true)
    try {
      await api.broadcasts.send(id)
      load()
    } catch {
      setError('送信に失敗しました')
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div>
        <Header title="配信詳細" />
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-64" />
          <div className="h-40 bg-gray-100 rounded" />
        </div>
      </div>
    )
  }

  if (!broadcast) {
    return (
      <div>
        <Header title="配信詳細" />
        <p className="text-gray-500">{error || '配信が見つかりません'}</p>
      </div>
    )
  }

  const raw = broadcast as unknown as Record<string, unknown>
  const accountId = raw.lineAccountId as string | null

  return (
    <div>
      <Header
        title={broadcast.title}
        action={
          <button
            onClick={() => router.push('/broadcasts', { scroll: false })}
            className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
          >
            ← 一覧に戻る
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Left: Preview */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">メッセージプレビュー</h3>
          {broadcast.messageType === 'flex' ? (
            <FlexPreviewComponent content={broadcast.messageContent} maxWidth={300} />
          ) : broadcast.messageType === 'image' ? (
            (() => {
              try {
                const img = JSON.parse(broadcast.messageContent)
                return <img src={img.originalContentUrl} alt="" className="max-w-[300px] rounded-lg" />
              } catch { return <p className="text-gray-400 text-sm">画像プレビュー不可</p> }
            })()
          ) : (
            <div className="bg-green-500 text-white rounded-2xl rounded-tl-sm px-4 py-3 max-w-[300px] text-sm whitespace-pre-wrap">
              {broadcast.messageContent}
            </div>
          )}
        </div>

        {/* Right: Settings */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">配信設定</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">種別</dt>
              <dd className="text-gray-900">{broadcast.messageType === 'text' ? 'テキスト' : broadcast.messageType === 'image' ? '画像' : 'Flex'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">対象</dt>
              <dd className="text-gray-900">
                {broadcast.targetType === 'all'
                  ? '全員'
                  : broadcast.targetTagId
                    ? `タグ: ${broadcast.targetTagId}`
                    : '選択した友だち'}
                {targetCount != null && <span className="ml-1 text-gray-500">({targetCount.toLocaleString('ja-JP')}人)</span>}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">ステータス</dt>
              <dd>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  broadcast.status === 'draft' ? 'bg-gray-100 text-gray-600' :
                  broadcast.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                  broadcast.status === 'sending' ? 'bg-yellow-100 text-yellow-700' :
                  'bg-green-100 text-green-700'
                }`}>
                  {broadcast.status === 'draft' ? '下書き' : broadcast.status === 'scheduled' ? '予約済み' : broadcast.status === 'sending' ? '送信中' : '送信完了'}
                </span>
              </dd>
            </div>
            {broadcast.scheduledAt && (
              <div className="flex justify-between">
                <dt className="text-gray-500">予約日時</dt>
                <dd className="text-gray-900">{new Date(broadcast.scheduledAt).toLocaleString('ja-JP')}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Segment Builder */}
      {broadcast.status === 'draft' && (
        <div className="mb-4">
          {!showSegmentBuilder ? (
            <button
              onClick={() => setShowSegmentBuilder(true)}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              セグメント条件を編集
            </button>
          ) : (
            <SegmentBuilder
              tags={tags}
              accountId={accountId}
              onApply={async (conditions) => {
                await api.broadcasts.update(id, { segmentConditions: JSON.stringify(conditions) } as unknown as Parameters<typeof api.broadcasts.update>[1])
                setShowSegmentBuilder(false)
                load()
              }}
              onCancel={() => setShowSegmentBuilder(false)}
            />
          )}
        </div>
      )}

      {/* Test Send */}
      {broadcast.status === 'draft' && accountId && (
        <div className="mb-4">
          <TestSendSection broadcastId={id} accountId={accountId} disabled={false} />
        </div>
      )}

      {/* Send Progress */}
      {broadcast.status === 'sending' && (
        <div className="mb-4">
          <ProgressBar totalCount={broadcast.totalCount} successCount={broadcast.successCount} />
        </div>
      )}

      {/* Insight */}
      {broadcast.status === 'sent' && insight && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">配信実績</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl font-bold text-gray-900">{insight.delivered?.toLocaleString('ja-JP') ?? '-'}</p>
              <p className="text-xs text-gray-500">配信</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600">{insight.uniqueImpression?.toLocaleString('ja-JP') ?? '-'}</p>
              <p className="text-xs text-gray-500">開封 {insight.openRate != null ? `(${(insight.openRate * 100).toFixed(1)}%)` : ''}</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{insight.uniqueClick?.toLocaleString('ja-JP') ?? '-'}</p>
              <p className="text-xs text-gray-500">クリック {insight.clickRate != null ? `(${(insight.clickRate * 100).toFixed(1)}%)` : ''}</p>
            </div>
          </div>
        </div>
      )}

      {/* Send Button */}
      {broadcast.status === 'draft' && (
        <button
          onClick={() => setShowConfirm(true)}
          disabled={sending}
          className="w-full px-4 py-3 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
          style={{ backgroundColor: '#06C755' }}
        >
          {sending ? '送信中...' : `この配信を送信する${targetCount != null ? ` (${targetCount.toLocaleString('ja-JP')}人)` : ''}`}
        </button>
      )}

      {/* Confirm Dialog */}
      {showConfirm && (
        <SendConfirmDialog
          title={broadcast.title}
          targetCount={targetCount ?? broadcast.totalCount}
          accountName={selectedAccount?.name ?? '-'}
          onConfirm={handleSend}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}
