"use client";

import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { MatrixQAResponse } from "@/lib/types";
import { Citation } from "./Citation";
import { useChat } from "ai/react";

interface QAChatInterfaceProps {
  sheetId: string;
  onCitationClick: (blockId: string) => void;
}

export const QAChatInterface: React.FC<QAChatInterfaceProps> = ({
  sheetId,
  onCitationClick
}) => {
  const [conversationId, setConversationId] = useState<string | undefined>(
    undefined
  );
  const messagesEndRef = useRef<null | HTMLDivElement>(null);

  const [messageMetadata, setMessageMetadata] = useState<
    Record<
      string,
      {
        citations?: MatrixQAResponse["citations"];
        steps?: string[];
      }
    >
  >({});

  const [lastResponseMetadata, setLastResponseMetadata] = useState<any>(null);

  const {
    messages: vercelMessages,
    input,
    handleInputChange,
    handleSubmit: handleAISubmit,
    isLoading
  } = useChat({
    api: "/api/qa",
    body: {
      sheetId,
      conversationId
    },
    onResponse: (response) => {
      console.log("Response received:", response);
      const resMetadataHeader = response.headers.get("X-Metadata");
      console.log("Response metadata header:", resMetadataHeader);
      if (resMetadataHeader) {
        try {
          const resMetadata = JSON.parse(resMetadataHeader);
          console.log("Response metadata received:", resMetadata);

          setLastResponseMetadata(resMetadata);

          if (resMetadata.conversationId && !conversationId) {
            setConversationId(resMetadata.conversationId);
          }
        } catch (e) {
          console.error("Failed to parse X-Metadata header", e);
          setLastResponseMetadata(null);
        }
      } else {
        setLastResponseMetadata(null);
      }
    },
    onFinish: (message) => {
      if (lastResponseMetadata) {
        console.log("Last response metadata:", lastResponseMetadata);
        setMessageMetadata((prev) => ({
          ...prev,
          [message.id]: {
            citations: lastResponseMetadata.citations,
            steps: lastResponseMetadata.steps
          }
        }));
        setLastResponseMetadata(null);
      }
      if (lastResponseMetadata?.conversationId && !conversationId) {
        setConversationId(lastResponseMetadata.conversationId);
      }
    },

    onError: (error) => {
      console.error("Chat error:", error);
      setLastResponseMetadata(null);
    }
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [vercelMessages]);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLastResponseMetadata(null);
    handleAISubmit(e, {
      options: {
        body: {
          sheetId,
          conversationId
        }
      }
    });
  };

  const renderMessageContent = (messageId: string, content: string) => {
    const metadata = messageMetadata[messageId] || {};
    const messageCitations = metadata.citations || [];

    const citationMap = new Map();
    messageCitations.forEach((citation) => {
      citationMap.set(citation.blockId, citation);
    });

    // Clean up content to avoid dots after citations
    let cleanedContent = content.replace(
      /\[cell:([a-fA-F0-9-]+)\]\./g,
      "[cell:$1]"
    );

    // Remove commas adjacent to citation markers
    cleanedContent = cleanedContent.replace(/,\s*\[cell:/g, " [cell:");
    cleanedContent = cleanedContent.replace(/\]\s*,/g, "] ");

    const regex = /\[cell:([a-fA-F0-9-]+)\]/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(cleanedContent)) !== null) {
      if (match.index > lastIndex) {
        const textPart = cleanedContent.substring(lastIndex, match.index);
        parts.push({
          type: "text",
          content: textPart
        });
      }

      const blockId = match[1];
      parts.push({
        type: "citation",
        blockId: blockId,
        contentSnippet: citationMap.get(blockId)?.contentSnippet
      });

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < cleanedContent.length) {
      parts.push({
        type: "text",
        content: cleanedContent.substring(lastIndex)
      });
    }

    return parts.map((part, index) => {
      if (part.type === "text") {
        return (
          <React.Fragment key={`${messageId}-text-${index}`}>
            <ReactMarkdown>{part.content}</ReactMarkdown>
          </React.Fragment>
        );
      } else {
        return (
          <Citation
            key={`${messageId}-citation-${index}`}
            blockId={part.blockId || ""}
            contentSnippet={part.contentSnippet}
            onClick={onCitationClick}
          />
        );
      }
    });
  };

  return (
    <div className='flex flex-col h-full bg-[#1e1e1e] rounded-md overflow-hidden border border-[#2d2d2d]'>
      {/* Message Display Area - Fixed height with scroll */}
      <div className='flex-grow overflow-y-auto p-4 space-y-4 scrollbar-thin scrollbar-thumb-gray-700'>
        {vercelMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-lg px-4 py-2 rounded-lg ${
                msg.role === "user"
                  ? "bg-purple-800 text-white"
                  : "bg-[#252525] text-gray-200"
              }`}
            >
              <div
                className={`prose prose-sm max-w-none ${
                  msg.role === "user" ? "prose-invert" : "prose-invert"
                }`}
              >
                {renderMessageContent(msg.id, msg.content)}
              </div>

              {msg.role === "assistant" && lastResponseMetadata && (
                <details className='text-xs mt-2 text-gray-400 cursor-pointer'>
                  <summary>
                    Agent Steps ({lastResponseMetadata?.steps?.length || 0})
                  </summary>
                  <ul className='list-disc pl-4 mt-1'>
                    {lastResponseMetadata?.steps?.map(
                      (step: string, index: number) => (
                        <li key={index}>{step}</li>
                      )
                    )}
                  </ul>
                </details>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area - Fixed at bottom */}
      <div className='p-3 border-t border-[#2d2d2d] bg-[#252525] flex-shrink-0'>
        <form onSubmit={handleFormSubmit} className='flex space-x-2'>
          <input
            type='text'
            value={input}
            onChange={handleInputChange}
            placeholder='Ask about the data...'
            disabled={isLoading}
            className='flex-grow px-3 py-2 bg-[#1e1e1e] border border-[#3d3d3d] rounded-md text-gray-200 focus:outline-none focus:ring-1 focus:ring-purple-600 disabled:bg-[#2a2a2a] disabled:text-gray-500'
            aria-label='Chat input'
          />
          <button
            type='submit'
            disabled={isLoading || !input.trim()}
            className='px-4 py-2 bg-purple-700 text-white rounded-md hover:bg-purple-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed focus:ring-offset-[#252525]'
            aria-label='Send chat message'
          >
            {isLoading ? (
              <span className='flex items-center gap-2'>
                <svg
                  className='animate-spin -ml-1 mr-2 h-4 w-4 text-white'
                  xmlns='http://www.w3.org/2000/svg'
                  fill='none'
                  viewBox='0 0 24 24'
                >
                  <circle
                    className='opacity-25'
                    cx='12'
                    cy='12'
                    r='10'
                    stroke='currentColor'
                    strokeWidth='4'
                  ></circle>
                  <path
                    className='opacity-75'
                    fill='currentColor'
                    d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                  ></path>
                </svg>
                Send
              </span>
            ) : (
              "Send"
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
