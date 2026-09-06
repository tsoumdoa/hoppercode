using System;

namespace rhino_zmq_poc
{
    /// <summary>
    /// Keeps cleanup bound to the document that opened the transaction, even when
    /// the host's active document changes before lifecycle cleanup runs.
    /// </summary>
    internal sealed class BoundTransactionState<TDocument, TSnapshot>
        where TDocument : class
        where TSnapshot : class
    {
        private TDocument _document;
        private TSnapshot _snapshot;

        public bool IsActive => _document != null;

        public bool IsBoundTo(TDocument document) =>
            IsActive && ReferenceEquals(_document, document);

        public void Begin(TDocument document, TSnapshot snapshot)
        {
            _document = document ?? throw new ArgumentNullException(nameof(document));
            _snapshot = snapshot ?? throw new ArgumentNullException(nameof(snapshot));
        }

        public TResult Complete<TResult>(Func<TDocument, TSnapshot, TResult> completion)
        {
            if (!IsActive)
                throw new InvalidOperationException("No transaction is active.");
            if (completion == null)
                throw new ArgumentNullException(nameof(completion));

            var document = _document;
            var snapshot = _snapshot;
            try
            {
                return completion(document, snapshot);
            }
            finally
            {
                _document = null;
                _snapshot = null;
            }
        }
    }
}
